// Reuse the PR merge gate at deployment, with proof of the exact source tree.
// No dependency install or product tests run in this gate.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ARTIFACT_NAME = "verified-source";
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const repo = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
const runId = (value) => /^[1-9][0-9]{0,19}$/u.test(String(value));
const sameRepo = (a, b) =>
  repo(a) && repo(b) && a.toLowerCase() === b.toLowerCase();
const fail = (message) => {
  throw new Error(message);
};

export function sourceReceipt({
  repository,
  headSha,
  commitSha,
  treeSha,
  verificationRunId,
  baseRef,
}) {
  if (
    !repo(repository) ||
    !sha(headSha) ||
    !sha(commitSha) ||
    !sha(treeSha) ||
    !runId(verificationRunId) ||
    typeof baseRef !== "string" ||
    !baseRef ||
    baseRef.length > 255
  )
    fail("Invalid verified-source receipt metadata.");
  return {
    version: 1,
    repository,
    head_sha: headSha,
    commit_sha: commitSha,
    tree_sha: treeSha,
    run_id: String(verificationRunId),
    base_ref: baseRef,
  };
}

export function mergedPull(pulls, repository, releaseSha) {
  if (!repo(repository) || !sha(releaseSha)) fail("Invalid release identity.");
  const candidates = pulls.filter(
    (p) =>
      p.merged_at &&
      p.state === "closed" &&
      p.merge_commit_sha === releaseSha &&
      p.base?.ref === "main" &&
      sameRepo(p.base?.repo?.full_name, repository) &&
      sha(p.head?.sha),
  );
  if (candidates.length !== 1)
    fail(
      "The release must be the merge of one verified pull request into main.",
    );
  return candidates[0];
}

export function verificationRun(runs, repository, headSha) {
  // Keep the API's newest-first order. A newer failure, cancellation or pending
  // attempt must not be hidden by selecting an older successful run.
  const latest = runs.find(
    (r) =>
      r.head_sha === headSha &&
      r.event === "pull_request" &&
      sameRepo(r.repository?.full_name, repository) &&
      r.path === ".github/workflows/ci.yml",
  );
  if (
    !latest ||
    !runId(latest.id) ||
    latest.status !== "completed" ||
    latest.conclusion !== "success"
  )
    fail(
      "The latest PR verification for this source is not completed successfully.",
    );
  return latest;
}

export function assertReceipt(
  receipt,
  { repository, headSha, verificationRunId, treeSha },
) {
  const validated = sourceReceipt({
    repository: receipt?.repository,
    headSha: receipt?.head_sha,
    commitSha: receipt?.commit_sha,
    treeSha: receipt?.tree_sha,
    verificationRunId: receipt?.run_id,
    baseRef: receipt?.base_ref,
  });
  if (
    receipt.version !== 1 ||
    validated.base_ref !== "main" ||
    !sameRepo(validated.repository, repository) ||
    validated.head_sha !== headSha ||
    validated.run_id !== String(verificationRunId) ||
    validated.tree_sha !== treeSha
  )
    fail(
      "The release source tree does not match its successful PR verification receipt. Merge current main into the PR and verify that result before deployment.",
    );
  return validated;
}

export async function resolveVerification({ repository, releaseSha, request }) {
  if (!repo(repository) || !sha(releaseSha)) fail("Invalid release identity.");
  const pulls = await request(
    `/repos/${repository}/commits/${releaseSha}/pulls?per_page=100`,
  );
  const pull = mergedPull(pulls, repository, releaseSha);
  const runs = await request(
    `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=100`,
  );
  const run = verificationRun(runs.workflow_runs, repository, pull.head.sha);
  const artifacts = await request(
    `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
  );
  if (
    !artifacts.artifacts?.some(
      (a) => a.name === ARTIFACT_NAME && a.expired === false,
    )
  )
    fail(
      "The successful PR verification has no current verified-source artifact. Re-run that verification to produce its receipt; older workflows without receipts need a fresh verified PR.",
    );
  return { run_id: String(run.id), head_sha: pull.head.sha };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const checkedOut = (env) => {
  if (!sha(env.GITHUB_SHA) || git("rev-parse", "HEAD") !== env.GITHUB_SHA)
    fail("Checkout does not match the workflow commit.");
  return git("rev-parse", "HEAD^{tree}");
};
async function main(mode, env) {
  if (mode === "attest") {
    const receipt = sourceReceipt({
      repository: env.GITHUB_REPOSITORY,
      headSha: env.VERIFIED_HEAD_SHA,
      commitSha: env.GITHUB_SHA,
      treeSha: checkedOut(env),
      verificationRunId: env.GITHUB_RUN_ID,
      baseRef: env.VERIFIED_BASE_REF,
    });
    if (env.GITHUB_EVENT_NAME !== "pull_request")
      fail("Only PR verification can attest source.");
    await mkdir(dirname(env.VERIFIED_SOURCE_FILE), { recursive: true });
    await writeFile(
      env.VERIFIED_SOURCE_FILE,
      JSON.stringify(receipt, null, 2) + "\n",
    );
    return;
  }
  if (env.GITHUB_REF !== "refs/heads/main") fail("Deployments must use main.");
  const tree = checkedOut(env);
  if (mode === "resolve") {
    if (!repo(env.GITHUB_REPOSITORY) || !env.GH_TOKEN || !env.GITHUB_OUTPUT)
      fail("Missing deployment verification configuration.");
    const request = async (path) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok)
        fail(`GitHub verification lookup failed (HTTP ${response.status}).`);
      return response.json();
    };
    const selected = await resolveVerification({
      repository: env.GITHUB_REPOSITORY,
      releaseSha: env.GITHUB_SHA,
      request,
    });
    await appendFile(
      env.GITHUB_OUTPUT,
      `run_id=${selected.run_id}\nhead_sha=${selected.head_sha}\n`,
    );
    return;
  }
  if (mode === "verify") {
    const receipt = JSON.parse(
      await readFile(env.VERIFIED_SOURCE_FILE, "utf8"),
    );
    assertReceipt(receipt, {
      repository: env.GITHUB_REPOSITORY,
      headSha: env.VERIFIED_HEAD_SHA,
      verificationRunId: env.VERIFIED_RUN_ID,
      treeSha: tree,
    });
    console.log(
      `Release ${env.GITHUB_SHA} matches PR verification ${receipt.run_id} (${tree}).`,
    );
    return;
  }
  fail("Use attest, resolve or verify.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2], process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
