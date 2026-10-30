import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { addDays, isAllocationDate } from "./allocation.js";

/**
 * Contract for read-only planning ICS feeds (issue 1194). Pure: no storage, no
 * routes, no network. Native subscriptions are implemented in calendar-feeds.ts
 * and resource-calendar-feed.ts; these compatible pure helpers still satisfy
 * docs/planning-ics-feed.md and test/planning-ics.test.ts.
 */

export type PlanningFeedKind = "allocation" | "time_off" | "holiday";

/** One already-authorized, already-minimized all-day span from the projection. */
export interface PlanningFeedItem {
  /** Stable opaque identity per resource and week (or leave span). Never a name or email. */
  key: string;
  kind: PlanningFeedKind;
  /** Floating dates, both ends inclusive, as stored. */
  startDate: string;
  endDate: string;
  /** Minimized label. The projection decides what is safe; this module only escapes it. */
  summary: string;
  /** Monotonic per key. Rendered as SEQUENCE. */
  revision: number;
}

/** A removed item. Keeps its key and last span so clients drop the event. */
export interface PlanningFeedTombstone {
  key: string;
  kind: PlanningFeedKind;
  startDate: string;
  endDate: string;
  /** Strictly greater than the last live revision of the key. */
  revision: number;
}

export interface PlanningIcsInput {
  calendarName: string;
  /** Instance host used only to make UIDs globally unique. */
  host: string;
  /** UTC instant, ISO 8601. Used for DTSTAMP so identical data renders identical bytes. */
  generatedAt: string;
  items: readonly PlanningFeedItem[];
  tombstones?: readonly PlanningFeedTombstone[];
}

export class PlanningIcsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningIcsInputError";
  }
}

const advisoryNote =
  "Advisory planning information. Not scheduled or tracked time.";
const kindLabels: Record<PlanningFeedKind, string> = {
  allocation: "Planned",
  time_off: "Time off",
  holiday: "Holiday",
};

/** RFC 5545 TEXT escaping. Controls (including CR, LF and NUL) cannot start a new property. */
export const escapeIcsText = (value: string): string =>
  value
    .replace(/[\\;,]/gu, (m) => `\\${m}`)
    .replace(/\r\n|\r|\n|\u0085|\u2028|\u2029/gu, "\\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, " ");

const utf8 = new TextEncoder();

/** Folds a content line at 75 octets without splitting a code point. CRLF-terminated lines. */
export const foldIcsLine = (line: string): string => {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const width = utf8.encode(char).length;
    if (size + width > limit) {
      parts.push(current);
      current = " ";
      size = 1;
      limit = 75;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n");
};

const compactDate = (date: string): string => date.replaceAll("-", "");

const compactUtc = (iso: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()))
    throw new PlanningIcsInputError("generatedAt must be a valid instant");
  return parsed.toISOString().replace(/[-:]|\.\d{3}/gu, "");
};

const validKey = /^[A-Za-z0-9._-]{1,128}$/u;
const validHost = /^[A-Za-z0-9.-]{1,253}$/u;

const checkSpan = (span: {
  key: string;
  startDate: string;
  endDate: string;
  revision: number;
}): void => {
  if (!validKey.test(span.key))
    throw new PlanningIcsInputError("key must be an opaque token");
  if (
    !isAllocationDate(span.startDate) ||
    !isAllocationDate(span.endDate) ||
    span.endDate < span.startDate
  )
    throw new PlanningIcsInputError(
      "span must be real inclusive dates in order",
    );
  if (!Number.isSafeInteger(span.revision) || span.revision < 0)
    throw new PlanningIcsInputError("revision must be a non-negative integer");
};

/** Stable UID: one per resource/week key, independent of label or revision. */
export const planningIcsUid = (key: string, host: string): string =>
  `${key}@${host}`;

/**
 * Renders an all-day, transparent (free), advisory VEVENT per item. DTEND is the
 * exclusive day after the inclusive end date. A key present in both items and
 * tombstones renders live only if the item revision is higher.
 */
export const renderPlanningIcs = (input: PlanningIcsInput): string => {
  if (!validHost.test(input.host))
    throw new PlanningIcsInputError("host is not a valid hostname");
  const stamp = compactUtc(input.generatedAt);
  const live = new Map<string, PlanningFeedItem>();
  for (const item of input.items) {
    checkSpan(item);
    if (live.has(item.key))
      throw new PlanningIcsInputError(`duplicate key ${item.key}`);
    live.set(item.key, item);
  }
  const events: { sortKey: string; lines: string[] }[] = [];
  const event = (
    span: PlanningFeedItem | PlanningFeedTombstone,
    summary: string,
    cancelled: boolean,
  ): void => {
    events.push({
      sortKey: `${span.startDate}|${span.key}`,
      lines: [
        "BEGIN:VEVENT",
        `UID:${planningIcsUid(span.key, input.host)}`,
        `DTSTAMP:${stamp}`,
        `SEQUENCE:${span.revision}`,
        `DTSTART;VALUE=DATE:${compactDate(span.startDate)}`,
        `DTEND;VALUE=DATE:${compactDate(addDays(span.endDate, 1))}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `DESCRIPTION:${escapeIcsText(advisoryNote)}`,
        `CATEGORIES:${escapeIcsText(kindLabels[span.kind])}`,
        `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      ],
    });
  };
  for (const item of live.values()) event(item, item.summary, false);
  for (const stone of input.tombstones ?? []) {
    checkSpan(stone);
    const current = live.get(stone.key);
    if (current && current.revision >= stone.revision) continue;
    if (current)
      throw new PlanningIcsInputError(
        `tombstone for live key ${stone.key} is newer than the item`,
      );
    event(stone, kindLabels[stone.kind], true);
  }
  events.sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
  );
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ezacto//planning feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
    ...events.flatMap((e) => e.lines),
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
};

/** Who a subscription reads for. Management scopes need an explicit permitted grant. */
export type PlanningFeedScope =
  | { kind: "self" }
  | { kind: "project"; projectId: number }
  | { kind: "team"; teamId: number };

/** Row stored for a subscription. The secret is never stored, only its hash. */
export interface PlanningFeedCredential {
  id: number;
  ownerUserId: number;
  scope: PlanningFeedScope;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const planningFeedTokenPrefix = "ezpf_";

export const hashPlanningFeedToken = (token: string): string =>
  bytesToHex(sha256(utf8.encode(token)));

/** 32 random bytes, base64url. The caller supplies the bytes (CSPRNG) so this stays pure. */
export const formatPlanningFeedToken = (randomBytes: Uint8Array): string => {
  if (randomBytes.length !== 32)
    throw new PlanningIcsInputError("token needs 32 random bytes");
  return (
    planningFeedTokenPrefix +
    btoa(String.fromCharCode(...randomBytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );
};

export interface PlanningFeedAccessFacts {
  credential: PlanningFeedCredential;
  now: string;
  /** Owner still active and not erased. Read fresh on every request. */
  ownerActive: boolean;
  /** The owner's current permission still covers the credential scope. Read fresh. */
  scopePermitted: boolean;
}

export type PlanningFeedDenial =
  "revoked" | "expired" | "owner_inactive" | "scope_not_permitted";

/**
 * Every denial is answered identically to the client (404, empty body, no
 * content), so a token holder learns nothing about why. The reason is for the
 * server-side audit log only.
 */
export const evaluatePlanningFeedAccess = (
  facts: PlanningFeedAccessFacts,
): { allow: true } | { allow: false; reason: PlanningFeedDenial } => {
  const { credential } = facts;
  if (credential.revokedAt !== null) return { allow: false, reason: "revoked" };
  if (facts.now >= credential.expiresAt)
    return { allow: false, reason: "expired" };
  if (!facts.ownerActive) return { allow: false, reason: "owner_inactive" };
  if (!facts.scopePermitted)
    return { allow: false, reason: "scope_not_permitted" };
  return { allow: true };
};

/** Headers for every feed response, allowed or denied. */
export const planningFeedResponseHeaders = (
  allowed: boolean,
): Record<string, string> => ({
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  ...(allowed ? { "content-type": "text/calendar; charset=utf-8" } : {}),
});
