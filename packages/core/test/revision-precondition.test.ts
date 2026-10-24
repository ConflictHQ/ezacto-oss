import { describe, expect, it } from "vitest";
import {
  decideRevisionedWrite,
  parseExpectedRevision,
  TrackedResourceInputError,
} from "../src/index.js";
import {
  describeRevisionStoreContract,
  type AuditEvent,
  type RevisionedStoreUnderTest,
  type SuiteRow,
} from "./revision-store-suite.js";

/** In-memory fake: one synchronous critical section per write, as a D1 batch is. */
const fakeStore = (): RevisionedStoreUnderTest => {
  const rows = new Map<number, SuiteRow>();
  const events: AuditEvent[] = [];
  let next = 1;
  return {
    async seed(note) {
      const row = { id: next++, note, version: 0 };
      rows.set(row.id, row);
      return { ...row };
    },
    async read(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async update(a) {
      await Promise.resolve();
      const current = rows.get(a.id) ?? null;
      const d = decideRevisionedWrite({
        current,
        authorized: a.authorized,
        expected: a.expected,
      });
      if (!d.ok) return d.refusal;
      rows.set(a.id, { id: a.id, note: a.note, version: d.nextVersion });
      events.push({
        id: events.length + 1,
        actorId: a.actorId,
        action: "update",
        beforeRevision: current!.version,
        afterRevision: d.nextVersion,
      });
      return "ok";
    },
    async remove(a) {
      await Promise.resolve();
      const current = rows.get(a.id) ?? null;
      const d = decideRevisionedWrite({
        current,
        authorized: a.authorized,
        expected: a.expected,
      });
      if (!d.ok) return d.refusal;
      rows.delete(a.id);
      events.push({
        id: events.length + 1,
        actorId: a.actorId,
        action: "delete",
        beforeRevision: current!.version,
        afterRevision: null,
      });
      return "ok";
    },
    async audit() {
      return events.map((e) => ({ ...e }));
    },
  };
};

describe("fake revisioned store satisfies the reusable contract", () => {
  describeRevisionStoreContract(fakeStore);
});

describe("parseExpectedRevision", () => {
  it("reads a supplied whole number under either policy", () => {
    for (const policy of ["required", "legacy-unconditioned"] as const) {
      expect(parseExpectedRevision({ version: 0 }, policy)).toBe(0);
      expect(parseExpectedRevision({ version: 12 }, policy)).toBe(12);
    }
  });
  it("lets only the legacy policy omit it", () => {
    expect(parseExpectedRevision({}, "legacy-unconditioned")).toBeNull();
    expect(() => parseExpectedRevision({}, "required")).toThrow(
      TrackedResourceInputError,
    );
  });
  it("never ignores a supplied value that is not a version", () => {
    for (const bad of [
      null,
      undefined,
      "1",
      -1,
      1.5,
      Number.NaN,
      Infinity,
      2 ** 60,
      true,
      {},
    ])
      for (const policy of ["required", "legacy-unconditioned"] as const)
        expect(() => parseExpectedRevision({ version: bad }, policy)).toThrow(
          expect.objectContaining({
            field: "version",
            reasonCode: "invalid_version",
          }),
        );
  });
});

describe("decideRevisionedWrite order", () => {
  const current = { version: 3 };
  it("orders not_found, forbidden, stale", () => {
    expect(
      decideRevisionedWrite({ current: null, authorized: false, expected: 9 }),
    ).toEqual({ ok: false, refusal: "not_found" });
    expect(
      decideRevisionedWrite({ current, authorized: false, expected: 9 }),
    ).toEqual({ ok: false, refusal: "forbidden" });
    expect(
      decideRevisionedWrite({ current, authorized: true, expected: 2 }),
    ).toEqual({ ok: false, refusal: "stale" });
    expect(
      decideRevisionedWrite({ current, authorized: true, expected: 3 }),
    ).toEqual({ ok: true, nextVersion: 4 });
  });
});
