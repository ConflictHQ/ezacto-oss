import assert from "node:assert/strict";
import { test } from "node:test";
import { findOffenders } from "./check-tracked-symlinks.mjs";

const one = (path, target) => findOffenders([{ path, target }]);

test("an absolute node_modules symlink is rejected", () => {
  assert.equal(one("packages/db/node_modules", "/Users/someone/repo/node_modules").length, 1);
});

test("any tracked path under node_modules is rejected, even with a relative target", () => {
  assert.equal(one("packages/core/node_modules/x", "../y").length, 1);
});

test("an absolute target is rejected", () => {
  assert.equal(one("docs/link", "/etc/passwd").length, 1);
  assert.equal(one("docs/link", "C:\\repo\\x").length, 1);
});

test("a relative target escaping the repo is rejected", () => {
  assert.equal(one("docs/link", "../../outside").length, 1);
  assert.equal(one("link", "..").length, 1);
});

test("a relative target resolving into node_modules is rejected", () => {
  assert.equal(one("apps/link", "../node_modules/pkg").length, 1);
});

test("a relative target that stays inside the repo is accepted", () => {
  assert.deepEqual(one("docs/link", "../README.md"), []);
  assert.deepEqual(one("link", "docs/a.md"), []);
});

test("no links means no offenders, and every offender is reported", () => {
  assert.deepEqual(findOffenders([]), []);
  assert.equal(
    findOffenders([
      { path: "a", target: "/abs" },
      { path: "b", target: "ok.md" },
      { path: "c/node_modules", target: "x" },
    ]).length,
    2,
  );
});
