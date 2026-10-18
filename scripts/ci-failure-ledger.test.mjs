import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  SIGNATURES,
  UNCLASSIFIED,
  annotation,
  bucket,
  buildLedger,
  classify,
  isLedgerAttempt,
  renderTable,
} from "./ci-failure-ledger.mjs";

// Excerpts as recorded on the issue from real failed jobs.
const logs = {
  proxyHeap: `FAIL test/load-resume.test.ts > idempotent load and resume
AssertionError: false == true
 ❯ new AssertionError node-internal:internal_assertionerror:427:15
 ❯ Native ../../node_modules/miniflare/src/workers/core/proxy.worker.ts:150:4`,
  fetchSync: ` ❯ assert node-internal:internal_assert:49:15
 ❯ miniflare/src/workers/core/fetch-sync.ts:147:3
AssertionError: message?.id === id`,
  registry: "npm error code ECONNRESET\nnpm error network request to https://registry.npmjs.org/x failed",
  gyp: "gyp ERR! stack Error: read ECONNRESET\ngyp http GET https://nodejs.org/download/release/v22/node-headers.tar.gz",
  timeout: "Error: Test timed out in 20000ms\nTests  1 failed | 107 passed (108)",
  hook: "Error: Hook timed out in 10000ms.",
  other: "AssertionError: expected 3 to equal 4",
};

function job(id, name, conclusion, steps = [{ name: "test", conclusion }]) {
  const bare = name === "green" || name === "deploy";
  return { id, name: bare ? name : `verify / ${name}`, conclusion, steps };
}

test("each known signature is recognised from its recorded log", () => {
  assert.equal(classify(logs.proxyHeap), "miniflare-proxy-heap");
  assert.equal(classify(logs.fetchSync), "miniflare-fetch-sync");
  assert.equal(classify(logs.registry), "registry-reset");
  assert.equal(classify(logs.gyp), "registry-reset");
  assert.equal(classify(logs.timeout), "vitest-timeout");
  assert.equal(classify(logs.hook), "vitest-timeout");
});

test("a bare false == true from our own code is not claimed as upstream", () => {
  assert.equal(classify("AssertionError: false == true\n at test/resume.test.ts:12"), UNCLASSIFIED);
});

test("an unknown signature is reported as unclassified, never dropped", async () => {
  assert.equal(classify(logs.other), UNCLASSIFIED);
  assert.equal(classify(""), UNCLASSIFIED);
  assert.equal(classify(undefined), UNCLASSIFIED);
  const rows = await buildLedger([{ id: 1, name: "ci", head_sha: "abcdef123456", run_attempt: 1 }], {
    jobsFor: async () => [job(10, "test (api 1)", "failure")],
    logFor: async () => logs.other,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, UNCLASSIFIED);
  assert.equal(bucket(rows)[UNCLASSIFIED], 1);
  assert.equal(bucket([])[UNCLASSIFIED], 0);
});

test("zero-step and cancelled jobs are not ledger attempts", () => {
  assert.equal(isLedgerAttempt(job(1, "a", "failure", [])), false);
  assert.equal(isLedgerAttempt(job(1, "a", "cancelled")), false);
  assert.equal(isLedgerAttempt(job(1, "a", "success")), false);
  assert.equal(isLedgerAttempt(job(1, "a", "failure")), true);
  // The aggregate and deploy jobs fail because of verify, not on their own.
  assert.equal(isLedgerAttempt(job(1, "green", "failure")), false);
  assert.equal(isLedgerAttempt(job(1, "deploy", "failure")), false);
});

test("first-attempt result is kept when a re-run turns the job green", async () => {
  const attempts = {
    1: [job(10, "test (migrate)", "failure"), job(11, "lint", "success")],
    2: [job(20, "test (migrate)", "success"), job(21, "lint", "success")],
  };
  const rows = await buildLedger([{ id: 7, name: "deploy", head_sha: "1234567890", run_attempt: 2 }], {
    jobsFor: async (_id, attempt) => attempts[attempt],
    logFor: async (id) => (id === 10 ? logs.proxyHeap : ""),
  });
  assert.deepEqual(rows, [
    {
      run: 7,
      workflow: "deploy",
      sha: "12345678",
      attempt: 1,
      job: "verify / test (migrate)",
      step: "test",
      class: "miniflare-proxy-heap",
      rerun: "green",
    },
  ]);
  assert.match(renderTable(rows), /\| 7 \| 1 \| verify \/ test \(migrate\) \| test \| miniflare-proxy-heap \| green \|/);
});

test("an expired log is unclassified, not an error", async () => {
  const rows = await buildLedger([{ id: 2, name: "ci", run_attempt: 1 }], {
    jobsFor: async () => [job(5, "test (web)", "failure")],
    logFor: async () => "",
  });
  assert.equal(rows[0].class, UNCLASSIFIED);
});

test("the annotation names the class and links the ledger", () => {
  const known = annotation("test (migrate)", "miniflare-proxy-heap", "https://example.test/issues/745");
  assert.match(known, /^::error title=verify failure class: miniflare-proxy-heap::/);
  assert.match(known, /issues\/745$/);
  assert.match(annotation("x", UNCLASSIFIED, "u"), /No known signature matched/);
});

test("docs/testing-strategy.md lists exactly the script's signatures", async () => {
  const doc = await readFile(new URL("../docs/testing-strategy.md", import.meta.url), "utf8");
  const section = (doc.split("## CI failure ledger")[1] ?? "").split("\n## ")[0];
  const ids = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(
    ids,
    SIGNATURES.map((s) => s.id),
  );
  for (const s of SIGNATURES) assert.ok(section.includes(s.disposition), `${s.id} disposition matches the doc`);
});
