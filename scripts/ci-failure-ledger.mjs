// The verify failure ledger (issue 745). Every red verify job attempt gets a
// cause class, so the next failure is compared against the known signatures
// instead of being investigated afresh. The signatures below and the table in
// docs/testing-strategy.md are one list; a test keeps them equal.
//
//   node scripts/ci-failure-ledger.mjs --repo OWNER/NAME [--runs 50] [--json]
//       lists failed job attempts from the Actions REST API and buckets them.
//   node scripts/ci-failure-ledger.mjs --classify FILE --job NAME
//       classifies one job's log and prints a workflow annotation (CI use).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);

export const UNCLASSIFIED = "unclassified";

// Order matters: the first match wins, so the specific miniflare assertions come
// before the generic timeout, and the timeout before the network patterns.
export const SIGNATURES = [
  {
    id: "miniflare-proxy-heap",
    pattern: /proxy\.worker\.ts:150\b/,
    disposition: "Upstream; the narrow retry in the migrate resume test covers it",
  },
  {
    id: "miniflare-fetch-sync",
    pattern: /fetch-sync\.ts:147\b|message\?\.id === id/,
    disposition: "Upstream; no retry, re-run the job and record it",
  },
  {
    id: "vitest-timeout",
    pattern: /(?:Test|Hook) timed out in \d+ms/,
    disposition: "Budget against a loaded runner; compare the green duration before touching it",
  },
  {
    id: "registry-reset",
    pattern: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|npm (?:ERR!|error) network/,
    disposition: "Infrastructure; not ours, re-run the job",
  },
];

/** The class of one job log: the first matching signature, else "unclassified". */
export function classify(log) {
  const text = String(log ?? "");
  for (const signature of SIGNATURES) if (signature.pattern.test(text)) return signature.id;
  return UNCLASSIFIED;
}

/**
 * A job attempt belongs in the ledger when it failed after starting. A job that
 * failed with no steps never ran (the billing outage) and tells nothing about
 * the code; a cancelled job is not a failure. Only the reusable verify
 * workflow's jobs count: `green` and `deploy` fail because of them, not alone.
 */
export function isLedgerAttempt(job) {
  return job.name.startsWith("verify / ") && job.conclusion === "failure" && (job.steps?.length ?? 0) > 0;
}

/** First failed step name, so the table says where the job died. */
export function failedStep(job) {
  return job.steps?.find((step) => step.conclusion === "failure")?.name ?? "";
}

/**
 * Build the ledger from `runs`, using injected readers so the shape is testable
 * on recorded data: `jobsFor(runId, attempt)` returns that attempt's jobs and
 * `logFor(jobId)` returns the log text (or "" when it has expired).
 */
export async function buildLedger(runs, { jobsFor, logFor }) {
  const rows = [];
  for (const runInfo of runs) {
    const attempts = Math.max(1, runInfo.run_attempt ?? 1);
    const byAttempt = new Map();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      byAttempt.set(attempt, await jobsFor(runInfo.id, attempt));
    }
    for (const [attempt, jobs] of byAttempt) {
      for (const job of jobs.filter(isLedgerAttempt)) {
        const later = [...byAttempt]
          .filter(([n]) => n > attempt)
          .flatMap(([, laterJobs]) => laterJobs.filter((j) => j.name === job.name));
        const outcome = later.length === 0 ? "none" : later.at(-1).conclusion === "success" ? "green" : "red";
        rows.push({
          run: runInfo.id,
          workflow: runInfo.name,
          sha: String(runInfo.head_sha ?? "").slice(0, 8),
          attempt,
          job: job.name,
          step: failedStep(job),
          class: classify(await logFor(job.id)),
          rerun: outcome,
        });
      }
    }
  }
  return rows;
}

/** Count rows per class; unclassified is always present so it cannot hide. */
export function bucket(rows) {
  const counts = Object.fromEntries([...SIGNATURES.map((s) => s.id), UNCLASSIFIED].map((id) => [id, 0]));
  for (const row of rows) counts[row.class] += 1;
  return counts;
}

export function renderTable(rows) {
  const counts = bucket(rows);
  const summary = Object.entries(counts)
    .map(([id, n]) => `${id}: ${n}`)
    .join("  ");
  const lines = ["| run | attempt | job | failed step | class | rerun |", "|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.run} | ${r.attempt} | ${r.job} | ${r.step} | ${r.class} | ${r.rerun} |`);
  return `${lines.join("\n")}\n\n${summary}\n`;
}

/** The GitHub annotation for a failed job, naming the class and the issue. */
export function annotation(jobName, cls, issueUrl) {
  const known = SIGNATURES.find((s) => s.id === cls);
  const detail = known
    ? `${known.disposition}.`
    : "No known signature matched; investigate it, and add a signature if it recurs.";
  return `::error title=verify failure class: ${cls}::${jobName} failed with class ${cls}. ${detail} Ledger: ${issueUrl}`;
}

async function gh(path) {
  const { stdout } = await run("gh", ["api", path], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const issueRepo = process.env.GITHUB_REPOSITORY;
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  if (flag("classify")) {
    // No log means the job died before the test step (install, checkout).
    const cls = classify(await readFile(flag("classify"), "utf8").catch(() => ""));
    console.log(annotation(flag("job", "job"), cls, `${server}/${issueRepo ?? "OWNER/NAME"}/issues/745`));
    return;
  }
  const repo = flag("repo", issueRepo);
  if (!repo) throw new Error("--repo OWNER/NAME is required outside Actions");
  const count = Number(flag("runs", "50"));
  const runs = [];
  for (const workflow of ["ci.yml", "deploy.yml"]) {
    const page = JSON.parse(
      await gh(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=${count}&status=completed`),
    );
    runs.push(...page.workflow_runs);
  }
  const rows = await buildLedger(runs, {
    jobsFor: async (id, attempt) =>
      JSON.parse(await gh(`repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`)).jobs,
    logFor: (id) => gh(`repos/${repo}/actions/jobs/${id}/logs`).catch(() => ""),
  });
  console.log(argv.includes("--json") ? JSON.stringify({ counts: bucket(rows), rows }, null, 2) : renderTable(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
