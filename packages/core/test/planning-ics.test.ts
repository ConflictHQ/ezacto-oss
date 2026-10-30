import { describe, expect, it } from "vitest";
import {
  escapeIcsText,
  evaluatePlanningFeedAccess,
  foldIcsLine,
  formatPlanningFeedToken,
  hashPlanningFeedToken,
  planningFeedResponseHeaders,
  PlanningIcsInputError,
  renderPlanningIcs,
  type PlanningFeedCredential,
  type PlanningFeedItem,
} from "../src/index.js";

const unfold = (text: string): string[] =>
  text
    .replace(/\r\n[ \t]/gu, "")
    .split("\r\n")
    .filter((l) => l !== "");

const base = {
  calendarName: "My planning",
  host: "time.example.test",
  generatedAt: "2026-10-24T12:00:00.000Z",
};
const item = (over: Partial<PlanningFeedItem> = {}): PlanningFeedItem => ({
  key: "a-12-2026-10-19",
  kind: "allocation",
  startDate: "2026-10-19",
  endDate: "2026-10-23",
  summary: "Planned: Website",
  revision: 1,
  ...over,
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a\\n;b,c\r\nd")).toBe("a\\\\n\\;b\\,c\\nd");
  });
  it("cannot inject a property through CR, LF, NEL or line separators", () => {
    const out = renderPlanningIcs({
      ...base,
      items: [
        item({
          summary: "x\r\nATTENDEE:mailto:a@b\u0085ORGANIZER:z BEGIN:VEVENT\0",
        }),
      ],
    });
    const names = unfold(out).map((l) => l.split(/[:;]/u)[0]);
    expect(names).not.toContain("ATTENDEE");
    expect(names).not.toContain("ORGANIZER");
    expect(names.filter((n) => n === "BEGIN")).toHaveLength(2);
  });
});

describe("foldIcsLine", () => {
  it("folds at 75 octets, round-trips, and never splits a code point", () => {
    const line = "SUMMARY:" + "é日😀".repeat(40);
    const folded = foldIcsLine(line);
    for (const part of folded.split("\r\n"))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(unfold(folded + "\r\n")[0]).toBe(line);
    expect(folded).not.toContain("�");
  });
});

describe("renderPlanningIcs", () => {
  it("uses CRLF, all-day values, exclusive DTEND, transparent and advisory", () => {
    const out = renderPlanningIcs({ ...base, items: [item()] });
    expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(out.replace(/\r\n/gu, "")).not.toMatch(/[\r\n]/u);
    const lines = unfold(out);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261019");
    expect(lines).toContain("DTEND;VALUE=DATE:20261024");
    expect(lines).toContain("TRANSP:TRANSPARENT");
    expect(lines).toContain("UID:a-12-2026-10-19@time.example.test");
    expect(lines).toContain("DTSTAMP:20261024T120000Z");
    expect(
      lines.some((l) => l.startsWith("DTSTART:") || l.includes("T0")),
    ).toBe(false);
  });
  it("rolls DTEND across month, year and leap boundaries", () => {
    const lines = unfold(
      renderPlanningIcs({
        ...base,
        items: [
          item({ key: "y", startDate: "2026-12-28", endDate: "2026-12-31" }),
          item({ key: "l", startDate: "2028-02-28", endDate: "2028-02-29" }),
        ],
      }),
    );
    expect(lines).toContain("DTEND;VALUE=DATE:20270101");
    expect(lines).toContain("DTEND;VALUE=DATE:20280301");
  });
  it("keeps UID stable and raises SEQUENCE across revisions", () => {
    const a = unfold(
      renderPlanningIcs({ ...base, items: [item({ revision: 1 })] }),
    );
    const b = unfold(
      renderPlanningIcs({
        ...base,
        items: [item({ revision: 2, summary: "Changed" })],
      }),
    );
    expect(a.find((l) => l.startsWith("UID:"))).toBe(
      b.find((l) => l.startsWith("UID:")),
    );
    expect(a).toContain("SEQUENCE:1");
    expect(b).toContain("SEQUENCE:2");
  });
  it("is deterministic and ordered regardless of input order", () => {
    const x = item({
      key: "b",
      startDate: "2026-10-26",
      endDate: "2026-10-30",
    });
    const y = item({ key: "a" });
    expect(renderPlanningIcs({ ...base, items: [x, y] })).toBe(
      renderPlanningIcs({ ...base, items: [y, x] }),
    );
  });
  it("renders a removed item as CANCELLED with a higher sequence and no label", () => {
    const lines = unfold(
      renderPlanningIcs({
        ...base,
        items: [],
        tombstones: [
          {
            key: "gone",
            kind: "time_off",
            startDate: "2026-10-21",
            endDate: "2026-10-21",
            revision: 4,
          },
        ],
      }),
    );
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("SEQUENCE:4");
    expect(lines).toContain("SUMMARY:Time off");
  });
  it("a re-created key wins over an older tombstone, a newer tombstone for a live key is refused", () => {
    const stone = {
      key: "a-12-2026-10-19",
      kind: "allocation" as const,
      startDate: "2026-10-19",
      endDate: "2026-10-23",
    };
    const out = renderPlanningIcs({
      ...base,
      items: [item({ revision: 5 })],
      tombstones: [{ ...stone, revision: 3 }],
    });
    expect(unfold(out).filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(unfold(out)).toContain("STATUS:CONFIRMED");
    expect(() =>
      renderPlanningIcs({
        ...base,
        items: [item({ revision: 1 })],
        tombstones: [{ ...stone, revision: 2 }],
      }),
    ).toThrow(PlanningIcsInputError);
  });
  it("rejects bad dates, duplicate keys, opaque-key violations and bad hosts", () => {
    const bad = (over: Partial<PlanningFeedItem>) => () =>
      renderPlanningIcs({ ...base, items: [item(over)] });
    expect(bad({ startDate: "2026-02-30" })).toThrow(PlanningIcsInputError);
    expect(bad({ endDate: "2026-10-18" })).toThrow(PlanningIcsInputError);
    expect(bad({ key: "Leo Mata\r\nX" })).toThrow(PlanningIcsInputError);
    expect(bad({ revision: -1 })).toThrow(PlanningIcsInputError);
    expect(() =>
      renderPlanningIcs({ ...base, items: [item(), item()] }),
    ).toThrow(PlanningIcsInputError);
    expect(() =>
      renderPlanningIcs({ ...base, host: "a b", items: [] }),
    ).toThrow(PlanningIcsInputError);
  });
  it("renders an empty feed as a valid calendar", () => {
    expect(unfold(renderPlanningIcs({ ...base, items: [] }))).toEqual(
      expect.arrayContaining([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "END:VCALENDAR",
      ]),
    );
  });
});

describe("feed credentials", () => {
  const credential: PlanningFeedCredential = {
    id: 1,
    ownerUserId: 7,
    scope: { kind: "self" },
    tokenHash: hashPlanningFeedToken("x"),
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    revokedAt: null,
  };
  const facts = {
    credential,
    now: "2026-10-24T00:00:00.000Z",
    ownerActive: true,
    scopePermitted: true,
  };
  it("allows a live credential and denies each loss with a reason", () => {
    expect(evaluatePlanningFeedAccess(facts)).toEqual({ allow: true });
    expect(
      evaluatePlanningFeedAccess({
        ...facts,
        credential: { ...credential, revokedAt: facts.now },
      }),
    ).toEqual({ allow: false, reason: "revoked" });
    expect(
      evaluatePlanningFeedAccess({ ...facts, now: credential.expiresAt }),
    ).toEqual({ allow: false, reason: "expired" });
    expect(
      evaluatePlanningFeedAccess({ ...facts, ownerActive: false }),
    ).toEqual({ allow: false, reason: "owner_inactive" });
    expect(
      evaluatePlanningFeedAccess({ ...facts, scopePermitted: false }),
    ).toEqual({ allow: false, reason: "scope_not_permitted" });
  });
  it("hashes tokens to 64 hex and formats 32-byte tokens only", () => {
    expect(hashPlanningFeedToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const token = formatPlanningFeedToken(new Uint8Array(32).fill(251));
    expect(token).toMatch(/^ezpf_[A-Za-z0-9_-]{43}$/u);
    expect(() => formatPlanningFeedToken(new Uint8Array(8))).toThrow(
      PlanningIcsInputError,
    );
  });
  it("never caches or leaks referrers, and only an allowed response is text/calendar", () => {
    for (const allowed of [true, false]) {
      const h = planningFeedResponseHeaders(allowed);
      expect(h["cache-control"]).toBe("private, no-store");
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect("content-type" in h).toBe(allowed);
    }
  });
});
