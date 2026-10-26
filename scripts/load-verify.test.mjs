import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SHARDS, exitCode, renderSummary, repeatShard, summarize, testCommand } from "./load-verify.mjs";

const proxyHeap = "Native ../../node_modules/miniflare/src/workers/core/proxy.worker.ts:150:4";

test("web load uses the full npm pipeline without passing Vitest flags to the browser", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "web-load-command-"));
  try {
    const web = JSON.parse(await readFile(new URL("../apps/web/package.json", import.meta.url), "utf8"));
    const log = join(fixture, "calls.jsonl");
    const probe = join(fixture, "probe.cjs");
    await writeFile(probe, `require('node:fs').appendFileSync(process.env.PROBE_LOG, JSON.stringify(process.argv.slice(2))+'\\n'); if(process.env.FAIL_VITEST && process.argv[2]==='vitest') process.exit(23);`);
    const bin = join(fixture, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const vitest = join(bin, "vitest");
    await writeFile(vitest, `#!/bin/sh\nexec "${process.execPath}" "${probe}" vitest "$@"\n`);
    await chmod(vitest, 0o700);
    const phase = (name) => `"${process.execPath}" "${probe}" ${name}`;
    await writeFile(join(fixture, "package.json"), JSON.stringify({ scripts: {
      "test:load": web.scripts["test:load"],
      "theme:check": phase("theme"), "shell:generate": phase("shell"),
      "test:browser": phase("browser"),
    } }));
    const env = { ...process.env, PROBE_LOG: log };
    const run = spawnSync("npm", ["run", "test:load"], { cwd: fixture, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
      [["theme"], ["shell"], ["vitest", "run", "--maxWorkers=1"], ["browser"]]);
    await writeFile(log, "");
    const failed = spawnSync("npm", ["run", "test:load"], { cwd: fixture, env: { ...env, FAIL_VITEST: "1" }, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.ok(!(await readFile(log, "utf8")).includes('"browser"'));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("a shard command is one worker plus the verify matrix selection", () => {
  assert.deepEqual(testCommand("migrate"), ["npm", "test", "-w", "@conflict-hq/ezacto-migrate", "--", "--maxWorkers=1"]);
  assert.deepEqual(testCommand("api-1").slice(-5), ["--shard=1/3", "--exclude", "test/reports.test.ts", "--exclude", "test/money-resources.test.ts"]);
  assert.throws(() => testCommand("nope"), /unknown shard/);
});

test("every shard names a job, workspace and selection present in verify.yml", async () => {
  const verify = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  for (const shard of Object.values(SHARDS)) {
    const line = verify.split("\n").find((l) => l.includes(`name: ${shard.job},`));
    assert.ok(line, `verify.yml has no matrix entry named ${shard.job}`);
    for (let i = 1; i < shard.workspaces.length; i += 2) assert.ok(line.includes(shard.workspaces[i]), line);
    if (shard.shard) assert.ok(line.includes(`shard: ${shard.shard}`), line);
  }
});

test("only unclassified failures fail the gate; known ones lower the rate", () => {
  const known = [
    { passed: true, class: "", seconds: 1 },
    { passed: false, class: "miniflare-proxy-heap", seconds: 1 },
  ];
  assert.equal(exitCode(known), 0);
  assert.equal(summarize(known).passed, 1);
  assert.equal(exitCode([...known, { passed: false, class: "unclassified", seconds: 1 }]), 1);
});

test("the table shows pass rate and per-class counts", () => {
  const text = renderSummary("web", [
    { passed: true, class: "", seconds: 4 },
    { passed: false, class: "vitest-timeout", seconds: 9 },
  ], "none");
  assert.match(text, /\| web \| 2 \| 1 \| 1 \| 50% \| 0 \|/);
  assert.match(text, /vitest-timeout: 1/);
});

test("repeats run once each, with no retry, and classify from the log", async () => {
  const out = await mkdtemp(join(tmpdir(), "load-verify-"));
  const calls = [];
  const logs = ["", proxyHeap, "AssertionError: expected 3 to equal 4"];
  const exec = async (argv, logPath) => {
    calls.push(argv);
    const n = calls.length - 1;
    await writeFile(logPath, logs[n]);
    return n === 0 ? 0 : 1;
  };
  const results = await repeatShard({ shardName: "migrate", repeats: 3, out, taskset: "0", exec });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 3), ["taskset", "-c", "0"]);
  assert.deepEqual(results.map((r) => r.class), ["", "miniflare-proxy-heap", "unclassified"]);
  assert.equal(exitCode(results), 1);
});

test("a repeat that never produced a log is unclassified, not dropped", async () => {
  const out = await mkdtemp(join(tmpdir(), "load-verify-"));
  const results = await repeatShard({ shardName: "web", repeats: 1, out, exec: async () => 127 });
  assert.equal(results[0].class, "unclassified");
});
