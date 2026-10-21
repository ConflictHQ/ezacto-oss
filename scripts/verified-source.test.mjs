import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  sourceReceipt,
  assertReceipt,
  mergedPull,
  verificationRun,
  resolveVerification,
} from "./verified-source.mjs";
const repository = "owner/product",
  head = "1".repeat(40),
  release = "2".repeat(40),
  tree = "3".repeat(40);
const pull = {
  state: "closed",
  merged_at: "2026-10-21T14:00:00Z",
  merge_commit_sha: release,
  base: { ref: "main", repo: { full_name: repository } },
  head: { sha: head },
};
const run = {
  id: 42,
  repository: { full_name: repository },
  head_sha: head,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/ci.yml",
};
const receipt = () =>
  sourceReceipt({
    repository,
    headSha: head,
    commitSha: "4".repeat(40),
    treeSha: tree,
    verificationRunId: 42,
    baseRef: "main",
  });
const expected = {
  repository,
  headSha: head,
  verificationRunId: 42,
  treeSha: tree,
};

test("accepts a verified tree even when its tested merge commit differs from the landed merge commit", () => {
  assert.equal(assertReceipt(receipt(), expected).tree_sha, tree);
  assert.equal(mergedPull([pull], repository, release).head.sha, head);
});
test("refuses stale trees, different runs, repositories, PR heads and base branches", () => {
  for (const change of [
    { tree_sha: "5".repeat(40) },
    { run_id: "43" },
    { repository: "other/product" },
    { head_sha: "6".repeat(40) },
    { base_ref: "feature/other" },
    { version: 2 },
  ])
    assert.throws(() => assertReceipt({ ...receipt(), ...change }, expected));
});
test("requires a merged PR for this exact release and repository on main", () => {
  for (const change of [
    { merged_at: null },
    { state: "open" },
    { merge_commit_sha: head },
    { base: { ref: "other", repo: { full_name: repository } } },
    { base: { ref: "main", repo: { full_name: "other/product" } } },
  ])
    assert.throws(() =>
      mergedPull([{ ...pull, ...change }], repository, release),
    );
  assert.throws(() => mergedPull([pull, pull], repository, release));
  assert.throws(() => mergedPull([], repository, release));
});
test("requires the latest CI result, never an older green run after a failure, cancellation or pending run", () => {
  for (const change of [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
  ])
    assert.throws(() =>
      verificationRun([{ ...run, id: 43, ...change }, run], repository, head),
    );
  assert.equal(verificationRun([run], repository, head).id, 42);
});
test("does not accept unrelated workflows, events, heads or repositories as PR verification", () => {
  for (const change of [
    { path: ".github/workflows/docs.yml" },
    { event: "push" },
    { head_sha: release },
    { repository: { full_name: "other/product" } },
  ])
    assert.throws(() =>
      verificationRun([{ ...run, ...change }], repository, head),
    );
});
test("resolves through GitHub metadata and refuses expired or absent receipts", async () => {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.includes("/commits/")) return [pull];
    if (path.includes("/workflows/")) return { workflow_runs: [run] };
    return { artifacts: [{ name: "verified-source", expired: false }] };
  };
  assert.deepEqual(
    await resolveVerification({ repository, releaseSha: release, request }),
    { run_id: "42", head_sha: head },
  );
  assert.equal(calls.length, 3);
  for (const artifacts of [
    [],
    [{ name: "verified-source", expired: true }],
    [{ name: "other", expired: false }],
  ])
    await assert.rejects(
      resolveVerification({
        repository,
        releaseSha: release,
        request: async (path) =>
          path.includes("/commits/")
            ? [pull]
            : path.includes("/workflows/")
              ? { workflow_runs: [run] }
              : { artifacts },
      }),
      /no current/,
    );
});
test("stops at a red verification without attempting to download artifacts", async () => {
  const calls = [];
  await assert.rejects(
    resolveVerification({
      repository,
      releaseSha: release,
      request: async (path) => {
        calls.push(path);
        return path.includes("/commits/")
          ? [pull]
          : { workflow_runs: [{ ...run, conclusion: "failure" }] };
      },
    }),
    /not completed successfully/,
  );
  assert.equal(calls.length, 2);
});
test("receipt contains source provenance and no environment credentials", () => {
  assert.deepEqual(Object.keys(receipt()).sort(), [
    "base_ref",
    "commit_sha",
    "head_sha",
    "repository",
    "run_id",
    "tree_sha",
    "version",
  ]);
  for (const change of [
    { headSha: "bad" },
    { commitSha: "" },
    { treeSha: "x".repeat(40) },
    { verificationRunId: "42\nextra=bad" },
    { repository: "../../secrets" },
  ])
    assert.throws(() =>
      sourceReceipt({
        repository,
        headSha: head,
        commitSha: release,
        treeSha: tree,
        verificationRunId: 42,
        baseRef: "main",
        ...change,
      }),
    );
});
test("CLI binds its receipt to a real Git checkout, permits a same-tree merge and refuses changed or non-main releases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verified-source-"));
  const script = resolve("scripts/verified-source.mjs"),
    file = join(dir, "receipt.json");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    await writeFile(join(dir, "code.txt"), "verified\n");
    git("add", "code.txt");
    git("commit", "-m", "fixture");
    const first = git("rev-parse", "HEAD");
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: first,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_RUN_ID: "42",
      VERIFIED_HEAD_SHA: first,
      VERIFIED_BASE_REF: "main",
      VERIFIED_SOURCE_FILE: file,
      VERIFIED_RUN_ID: "42",
    };
    const cli = (mode, over = {}) =>
      spawnSync(process.execPath, [script, mode], {
        cwd: dir,
        env: { ...env, ...over },
        encoding: "utf8",
      });
    assert.equal(cli("attest").status, 0);
    const original = JSON.parse(await readFile(file, "utf8"));
    assert.equal(original.tree_sha, git("rev-parse", "HEAD^{tree}"));
    git("commit", "--allow-empty", "-m", "same tree merge");
    assert.equal(
      cli("verify", { GITHUB_SHA: git("rev-parse", "HEAD") }).status,
      0,
    );
    assert.notEqual(
      cli("verify", {
        GITHUB_SHA: git("rev-parse", "HEAD"),
        GITHUB_REF: "refs/heads/feature",
      }).status,
      0,
    );
    await writeFile(join(dir, "code.txt"), "changed\n");
    git("add", "code.txt");
    git("commit", "-m", "changed source");
    const refused = cli("verify", { GITHUB_SHA: git("rev-parse", "HEAD") });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /does not match/);
    assert.notEqual(
      cli("attest", {
        GITHUB_SHA: git("rev-parse", "HEAD"),
        GITHUB_EVENT_NAME: "push",
      }).status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
