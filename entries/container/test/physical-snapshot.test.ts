import * as fs from 'node:fs'
import {runInNewContext} from 'node:vm'
import {assertNoIncompletePrivacyRestore,prepareContainerDatabase} from '../src/runtime.js'
import {privacyRestoreCommand} from '../src/privacy-restore.js'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCanonicalTemporaryDirectory,
  createPhysicalSnapshotMetadata,
  verifyPhysicalSnapshot,
  restorePhysicalSnapshot,
} from '../../../scripts/container-physical-snapshot.mjs'

const helper = new URL(
  '../../../scripts/container-physical-snapshot.mjs',
  import.meta.url,
)

const roots: string[] = []

const fixture = async (): Promise<{
  root: string
  attachment: string
}> => {
  // realpath because macOS puts $TMPDIR under /var, itself a symlink to
  // /private/var. The code under test refuses a symlinked path on purpose, so
  // the fixture has to hand it a canonical one rather than the check be relaxed.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-physical-snapshot-')))
  roots.push(root)
  const database = new BetterSqlite3(join(root, 'db.sqlite'))
  database.exec(
    "CREATE TABLE fixture (value TEXT NOT NULL); INSERT INTO fixture VALUES ('kept')",
  )
  database.close()

  const bytes = Buffer.from('attachment survives physical restore')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const directory = join(root, 'attachments', 'sha256', hash.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const attachment = join(directory, hash)
  await writeFile(attachment, bytes)
  const metadata = await createPhysicalSnapshotMetadata(
    root,
    {
      container: 'ezacto',
      volume: 'ezacto-data',
      image: 'ezacto:test',
      image_id: `sha256:${'a'.repeat(64)}`,
    },
    '2026-09-01T00:00:00.000Z',
  )
  await writeFile(
    join(root, 'snapshot.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )
  return { root, attachment }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('container physical snapshot', () => {
  it('[regression #471] canonicalizes owned temp directories without accepting operator symlinks', async () => {
    const { root } = await fixture()
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-linked-temp-parent-')))
    roots.push(parent)
    const alias = join(parent, 'alias')
    await symlink(root, alias, 'dir')

    const temporary = await createCanonicalTemporaryDirectory('restore-', alias)
    expect(temporary).toBe(await realpath(temporary))
    expect(temporary.startsWith(`${root}/restore-`)).toBe(true)
    await expect(verifyPhysicalSnapshot(alias)).rejects.toThrow('must not be a symbolic link')
  })

  it('[unit] verifies the exact SQLite and content-addressed attachment inventory', async () => {
    const { root } = await fixture()

    await expect(verifyPhysicalSnapshot(root)).resolves.toMatchObject({
      schema_version: 1,
      kind: 'ezacto-container-physical-snapshot',
      files: [
        { path: expect.stringMatching(/^attachments\/sha256\//u) },
        { path: 'db.sqlite' },
      ],
    })

    const command = spawnSync(
      process.execPath,
      [helper.pathname, 'verify', '--bundle', root],
      { encoding: 'utf8' },
    )
    expect(command.status).toBe(0)
    expect(command.stdout).toContain(`physical snapshot verified: ${root}`)
    expect(command.stderr).toBe('')
  })

  it("[regression #973] keeps a failed quarantine helper restore blocked and rejects unsupported images before copying", async () => {
    const { root } = await fixture();
    const target = await createCanonicalTemporaryDirectory(
      "ezacto-failed-restore-",
    );
    roots.push(target);
    const execute = async (args: string[]) => {
      if (args[0] === "run" && args.includes("quarantine"))
        throw new Error("forced quarantine helper failure");
      if (args[0] === "run" && args.includes("-e")) {
        const code = args[args.indexOf("-e") + 1]!;
        if (!code.includes("accessSync"))
          runInNewContext(
            code
              .replaceAll("'/restore'", JSON.stringify(root))
              .replaceAll("'/data'", JSON.stringify(target)),
            {
              require: (name: string) => {
                if (name !== "node:fs") throw new Error("unexpected module");
                return { ...fs, chownSync: () => {} };
              },
            },
          );
      }
      if (args[0] === "container" && args[1] === "cp")
        fs.cpSync(target, args[3]!, { recursive: true });
      return { stdout: "", stderr: "" };
    };
    await expect(
      restorePhysicalSnapshot(
        { bundle: root, volume: "disposable-test", image: "fixture:new" },
        execute,
      ),
    ).rejects.toThrow("forced quarantine helper failure");
    expect(fs.existsSync(join(target, "db.sqlite"))).toBe(true);
    expect(fs.existsSync(join(target, ".privacy-restore-incomplete"))).toBe(
      true,
    );
    await expect(assertNoIncompletePrivacyRestore(target)).rejects.toThrow(
      "Incomplete physical restore",
    );
    privacyRestoreCommand(['quarantine','--database',join(target,'db.sqlite')]);
    expect(fs.existsSync(join(target,'.privacy-restore-incomplete'))).toBe(false);
    const quarantined=new BetterSqlite3(join(target,'db.sqlite'));
    try {expect(()=>prepareContainerDatabase(quarantined)).toThrow('privacy evidence must be reconciled')}finally{quarantined.close()}
    const preflightCalls:string[][]=[];
    await expect(
      restorePhysicalSnapshot(
        { bundle: root, volume: "disposable-other", image: "fixture:old" },
        async (args) => {
          preflightCalls.push(args);
          if (args.includes("-e") && args.at(-1)!.includes("accessSync"))
            throw new Error("helper unavailable");
          return { stdout: "", stderr: "" };
        },
      ),
    ).rejects.toThrow("helper unavailable");
    expect(preflightCalls.filter(args=>args[0]==='run')).toHaveLength(1);
    expect(preflightCalls.at(-1)!.at(-1)).toContain('accessSync');
  });
  it('[regression #973] flushes the marker and directory before copying and aborts on a directory flush failure',async()=>{
    const {root}=await fixture();const target=await createCanonicalTemporaryDirectory('ezacto-restore-fsync-');roots.push(target);
    const operations:string[]=[];
    await expect(restorePhysicalSnapshot({bundle:root,volume:'disposable-flush',image:'fixture:new'},async args=>{
      if(args[0]==='run'&&args.includes('-e')){
        const code=args[args.indexOf('-e')+1]!;
        if(!code.includes('accessSync'))runInNewContext(code.replaceAll("'/restore'",JSON.stringify(root)).replaceAll("'/data'",JSON.stringify(target)),{require:()=>({...fs,
          fsyncSync:(fd:number)=>{operations.push(fs.fstatSync(fd).isDirectory()?'directory-flush':'file-flush');if(fs.fstatSync(fd).isDirectory())throw new Error('forced directory flush failure');fs.fsyncSync(fd)},
          copyFileSync:()=>{operations.push('copy');throw new Error('copy must not start')},chownSync:()=>{}
        })});
      }
      return {stdout:'',stderr:''};
    })).rejects.toThrow('forced directory flush failure');
    expect(operations).toEqual(['file-flush','directory-flush']);
    expect(fs.existsSync(join(target,'db.sqlite'))).toBe(false);
    await expect(assertNoIncompletePrivacyRestore(target)).rejects.toThrow('Incomplete physical restore');
  });
  it('[security] rejects changed content and symbolic links', async () => {
    const changed = await fixture()
    await writeFile(changed.attachment, 'changed')
    await expect(verifyPhysicalSnapshot(changed.root)).rejects.toThrow(
      'content does not match its key',
    )

    const linked = await fixture()
    await symlink(
      join(linked.root, 'db.sqlite'),
      join(linked.root, 'attachments', 'database-link'),
    )
    await expect(verifyPhysicalSnapshot(linked.root)).rejects.toThrow(
      'must not be a symbolic link',
    )
  })
})
