import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  chmod,
  lstat,
  realpath,
  open,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CsvByteBudget,
  CsvStagingError,
  type CsvStagingStore,
} from "@ezacto/api";

const validKey = /^obj_[a-f0-9]{32}$/;
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
export const createCsvStagingDisk = async (
  root: string,
): Promise<
  CsvStagingStore & {
    sweepOrphans(known: ReadonlySet<string>, before: number): Promise<void>;
  }
> => {
  const expected = resolve(root);
  const directory = async () => {
    await mkdir(expected, { recursive: true, mode: 0o700 });
    const info = await lstat(expected);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(expected)) !== expected
    )
      throw new Error("CSV private directory unavailable");
    await chmod(expected, 0o700);
  };
  await directory();
  const path = (key: string) => {
    if (!validKey.test(key))
      throw new Error("Invalid private CSV object identity");
    return join(expected, key);
  };
  return {
    async put(_runId, body, proof) {
      await directory();
      const key = `obj_${randomUUID().replaceAll("-", "")}`;
      const target = path(key),
        temporary = `${target}.part`;
      const file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256"),
        budget = new CsvByteBudget();
      let installed = false;
      try {
        for await (const bytes of body) {
          budget.take(bytes);
          hash.update(bytes);
          await file.writeFile(bytes);
        }
        if (budget.bytes !== proof.bytes)
          throw new CsvStagingError("length_mismatch");
        const actual = hash.digest();
        if (
          !/^[a-f0-9]{64}$/.test(proof.sha256) ||
          !timingSafeEqual(actual, Buffer.from(proof.sha256, "hex"))
        )
          throw new CsvStagingError("hash_mismatch");
        await file.sync();
        await file.close();
        await rename(temporary, target);
        installed = true;
        return { objectKey: key };
      } finally {
        await file.close().catch(() => {});
        if (!installed)
          await unlink(temporary).catch((error) => {
            if (!missing(error)) throw error;
          });
      }
    },
    async read(key) {
      await directory();
      let file;
      try {
        file = await open(path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
          throw new CsvStagingError("file_too_large");
        return new Uint8Array(await file.readFile());
      } finally {
        await file.close();
      }
    },
    async delete(key) {
      await directory();
      await unlink(path(key)).catch((error) => {
        if (!missing(error)) throw error;
      });
    },
    async sweepOrphans(known, before) {
      await directory();
      for (const name of await readdir(expected)) {
        if (!validKey.test(name) && !/^obj_[a-f0-9]{32}\.part$/.test(name))
          continue;
        if (known.has(name)) continue;
        const object = join(expected, name),
          stat = await lstat(object);
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error("CSV private object unavailable");
        if (stat.mtimeMs <= before)
          await unlink(object).catch((error) => {
            if (!missing(error)) throw error;
          });
      }
    },
  };
};
