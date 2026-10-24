import { expect, it } from "vitest";
import type { Revisioned } from "../src/index.js";

export interface SuiteRow extends Revisioned {
  id: number;
  note: string;
}
export type SuiteOutcome = "ok" | "not_found" | "forbidden" | "stale";
export interface AuditEvent {
  id: number;
  actorId: number;
  action: "update" | "delete";
  beforeRevision: number;
  afterRevision: number | null;
}

/**
 * What any real allocation or time-off store must expose to the suite. Each
 * method is one atomic transaction that re-reads the row, applies
 * `decideRevisionedWrite` semantics and writes the audit event with the data.
 * `expected` null means the legacy caller sent no precondition.
 */
export interface RevisionedStoreUnderTest {
  seed(note: string): Promise<SuiteRow>;
  read(id: number): Promise<SuiteRow | null>;
  update(a: {
    id: number;
    actorId: number;
    expected: number | null;
    note: string;
    authorized: boolean;
  }): Promise<SuiteOutcome>;
  remove(a: {
    id: number;
    actorId: number;
    expected: number | null;
    authorized: boolean;
  }): Promise<SuiteOutcome>;
  audit(): Promise<AuditEvent[]>;
}

export const describeRevisionStoreContract = (
  make: () => RevisionedStoreUnderTest,
): void => {
  it("starts at revision zero and increments by exactly one per update", async () => {
    const s = make();
    const row = await s.seed("a");
    expect(row.revision).toBe(0);
    expect(
      await s.update({
        id: row.id,
        actorId: 1,
        expected: 0,
        note: "b",
        authorized: true,
      }),
    ).toBe("ok");
    expect((await s.read(row.id))?.revision).toBe(1);
    expect(
      await s.update({
        id: row.id,
        actorId: 1,
        expected: 1,
        note: "c",
        authorized: true,
      }),
    ).toBe("ok");
    expect((await s.read(row.id))?.revision).toBe(2);
  });

  it("refuses a stale update and delete without data change or audit event", async () => {
    const s = make();
    const row = await s.seed("a");
    await s.update({
      id: row.id,
      actorId: 1,
      expected: 0,
      note: "b",
      authorized: true,
    });
    const events = (await s.audit()).length;
    expect(
      await s.update({
        id: row.id,
        actorId: 2,
        expected: 0,
        note: "x",
        authorized: true,
      }),
    ).toBe("stale");
    expect(
      await s.remove({ id: row.id, actorId: 2, expected: 0, authorized: true }),
    ).toBe("stale");
    expect(await s.read(row.id)).toMatchObject({ note: "b", revision: 1 });
    expect((await s.audit()).length).toBe(events);
  });

  it("refuses a future revision as stale", async () => {
    const s = make();
    const row = await s.seed("a");
    expect(
      await s.update({
        id: row.id,
        actorId: 1,
        expected: 5,
        note: "x",
        authorized: true,
      }),
    ).toBe("stale");
  });

  it("checks authority before revision, so a stale caller without access learns only forbidden", async () => {
    const s = make();
    const row = await s.seed("a");
    await s.update({
      id: row.id,
      actorId: 1,
      expected: 0,
      note: "b",
      authorized: true,
    });
    expect(
      await s.update({
        id: row.id,
        actorId: 3,
        expected: 0,
        note: "x",
        authorized: false,
      }),
    ).toBe("forbidden");
    expect(
      await s.remove({
        id: row.id,
        actorId: 3,
        expected: 99,
        authorized: false,
      }),
    ).toBe("forbidden");
    expect(await s.read(row.id)).toMatchObject({ note: "b", revision: 1 });
  });

  it("reports a missing row as not_found whatever the precondition", async () => {
    const s = make();
    expect(
      await s.update({
        id: 404,
        actorId: 1,
        expected: 0,
        note: "x",
        authorized: true,
      }),
    ).toBe("not_found");
    expect(
      await s.remove({ id: 404, actorId: 1, expected: null, authorized: true }),
    ).toBe("not_found");
  });

  it("lets a legacy caller without a precondition write, still bumping the revision", async () => {
    const s = make();
    const row = await s.seed("a");
    expect(
      await s.update({
        id: row.id,
        actorId: 1,
        expected: null,
        note: "b",
        authorized: true,
      }),
    ).toBe("ok");
    expect((await s.read(row.id))?.revision).toBe(1);
  });

  it("lets exactly one of two concurrent writers at the same revision win", async () => {
    const s = make();
    const row = await s.seed("a");
    const results = await Promise.all([
      s.update({
        id: row.id,
        actorId: 1,
        expected: 0,
        note: "one",
        authorized: true,
      }),
      s.update({
        id: row.id,
        actorId: 2,
        expected: 0,
        note: "two",
        authorized: true,
      }),
      s.remove({ id: row.id, actorId: 3, expected: 0, authorized: true }),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(
      results.filter((r) => r === "stale" || r === "not_found"),
    ).toHaveLength(2);
    const events = await s.audit();
    expect(events).toHaveLength(1);
    expect(events[0]?.beforeRevision).toBe(0);
  });

  it("writes the before and after revision in the audit event of a successful update", async () => {
    const s = make();
    const row = await s.seed("a");
    await s.update({
      id: row.id,
      actorId: 7,
      expected: 0,
      note: "b",
      authorized: true,
    });
    expect(await s.audit()).toMatchObject([
      { actorId: 7, action: "update", beforeRevision: 0, afterRevision: 1 },
    ]);
  });
};
