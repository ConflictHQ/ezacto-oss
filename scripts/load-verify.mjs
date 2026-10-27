// Repeat one verify shard under deliberate load and report its pass rate
// (issue 745). Two green runs do not prove an intermittent gone; N runs on a
// starved runner are the evidence. Run by .github/workflows/load-verify.yml,
// which is manual-only.
//
//   node scripts/load-verify.mjs --shard migrate --repeats 10 [--out DIR] [--taskset 0]
//
// Every failed repeat is classified with the ledger signatures from
// scripts/ci-failure-ledger.mjs. Only an unclassified failure fails the run: a
// known upstream cause lowers the pass rate in the table, which is a finding,
// not a failure of this gate. There is no retry here; a repeat that fails is
// counted as failed.
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SIGNATURES, UNCLASSIFIED, classify } from "./ci-failure-ledger.mjs";

// Same workspaces, shard and file selection as the matrix in verify.yml; a test
// keeps the two in step. Only the shards the issue names as flake-prone.
export const SHARDS = {
  migrate: { job: "migrate", workspaces: ["-w", "@conflict-hq/ezacto-migrate"] },
  web: { job: "web", workspaces: ["-w", "@ezacto/web"] },
  worker: { job: "worker", workspaces: ["-w", "ezacto-worker"] },
  "api-1": {
    job: "api 1",
    workspaces: ["-w", "@ezacto/api"],
    shard: "1/3",
    exclude: ["test/reports.test.ts", "test/money-resources.test.ts"],
  },
  "db-10": { job: "db 10", workspaces: ["-w", "@ezacto/db"], shard: "10/12" },
};

/** The `npm test` argument list for a shard, with one worker (reduced CPU). */
export function testCommand(shardName) {
  const shard = SHARDS[shardName];
  if (!shard) throw new Error(`unknown shard ${shardName}; one of ${Object.keys(SHARDS).join(", ")}`);
  // npm appends arguments to the web script's final nested npm command, so
  // --maxWorkers never reaches Vitest. Scope it in the load entry point while
  // retaining the complete (already single-worker) browser sequence.
  if (shardName === "web") return ["npm", "run", "test:load", ...shard.workspaces];
  const args = ["test", ...shard.workspaces, "--", "--maxWorkers=1"];
  if (shard.shard) args.push(`--shard=${shard.shard}`);
  for (const file of shard.exclude ?? []) args.push("--exclude", file);
  return ["npm", ...args];
}

/** Per-class counts of the failed repeats. Unclassified is always present. */
export function summarize(results) {
  const failed = results.filter((r) => !r.passed);
  const classes = Object.fromEntries([...SIGNATURES.map((s) => s.id), UNCLASSIFIED].map((id) => [id, 0]));
  for (const r of failed) classes[r.class] += 1;
  return {
    repeats: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    classes,
    unclassified: classes[UNCLASSIFIED],
  };
}

export function renderSummary(shardName, results, load) {
  const s = summarize(results);
  const rate = s.repeats === 0 ? "n/a" : `${((s.passed / s.repeats) * 100).toFixed(0)}%`;
  const lines = [
    `## load-verify: ${shardName}`,
    "",
    `Load: ${load}. One worker, no retry.`,
    "",
    "| shard | repeats | passed | failed | pass rate | unclassified |",
    "|---|---|---|---|---|---|",
    `| ${shardName} | ${s.repeats} | ${s.passed} | ${s.failed} | ${rate} | ${s.unclassified} |`,
    "",
    "| repeat | result | class | seconds |",
    "|---|---|---|---|",
    ...results.map((r, i) => `| ${i + 1} | ${r.passed ? "pass" : "fail"} | ${r.passed ? "" : r.class} | ${r.seconds} |`),
    "",
    Object.entries(s.classes)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id}: ${n}`)
      .join("  ") || "no failures",
    "",
  ];
  return lines.join("\n");
}

/** The gate: red only when a failure matched no known signature. */
export function exitCode(results) {
  return summarize(results).unclassified > 0 ? 1 : 0;
}

/** Run argv, teeing combined output to `logPath`; resolves to the exit code. */
function runLogged(argv, logPath) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const chunks = [];
    const take = (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      chunks.push(Buffer.from(`spawn failed: ${error.message}\n`));
      resolve(127);
    });
    child.on("close", async (code) => {
      await writeFile(logPath, Buffer.concat(chunks));
      resolve(code ?? 1);
    });
  });
}

/** Repeat the shard; `exec(argv, logPath)` is injectable so the loop is testable. */
export async function repeatShard({ shardName, repeats, out, taskset, exec = runLogged }) {
  await mkdir(out, { recursive: true });
  const command = testCommand(shardName);
  const argv = taskset ? ["taskset", "-c", taskset, ...command] : command;
  const results = [];
  for (let n = 1; n <= repeats; n += 1) {
    const logPath = join(out, `${shardName}-${n}.log`);
    const started = Date.now();
    const code = await exec(argv, logPath);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (code === 0) {
      results.push({ passed: true, class: "", seconds });
      continue;
    }
    // No log means the command never started: unclassified, never dropped.
    const log = await readFile(logPath, "utf8").catch(() => "");
    results.push({ passed: false, class: classify(log), seconds });
  }
  return results;
}

async function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const shardName = flag("shard");
  const repeats = Number(flag("repeats", "10"));
  if (!shardName) throw new Error("--shard is required");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  const taskset = flag("taskset", "");
  const out = flag("out", join(process.env.RUNNER_TEMP ?? ".", "load-verify"));
  const results = await repeatShard({ shardName, repeats, out, taskset });
  const load = taskset ? `pinned to CPU ${taskset}, concurrent CPU burner` : "none";
  const summary = renderSummary(shardName, results, load);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = exitCode(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
