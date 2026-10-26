import { describe, expect, it } from "vitest";
import {
  calendarFeedExpiry,
  createCalendarFeedSecret,
  hashCalendarFeedPassword,
  parseCalendarFeedAuthorization,
  verifyCalendarFeedPassword,
} from "../src/calendar-feed-credential.js";
const nonce = "a".repeat(64);
describe("calendar subscription credential boundary", () => {
  it("[security] creates separate opaque public ID, password and private UID namespace", () => {
    const a = createCalendarFeedSecret(),
      b = createCalendarFeedSecret();
    expect(a.id).toMatch(/^[a-f0-9]{32}$/);
    expect(a.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.namespace).toMatch(/^[a-f0-9]{64}$/);
    expect(
      new Set([a.id, a.password, a.namespace, b.id, b.password, b.namespace])
        .size,
    ).toBe(6);
  });
  it("[security] verifies a keyed hash without storing the password, and binds feed+instance", async () => {
    const a = createCalendarFeedSecret(),
      b = createCalendarFeedSecret();
    const hash = await hashCalendarFeedPassword(nonce, a.id, a.password);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(a.password);
    expect(
      await verifyCalendarFeedPassword(nonce, a.id, a.password, hash),
    ).toBe(true);
    expect(
      await verifyCalendarFeedPassword("b".repeat(64), a.id, a.password, hash),
    ).toBe(false);
    expect(
      await verifyCalendarFeedPassword(nonce, b.id, a.password, hash),
    ).toBe(false);
    expect(
      await verifyCalendarFeedPassword(nonce, a.id, b.password, hash),
    ).toBe(false);
    expect(
      await verifyCalendarFeedPassword(nonce, a.id, a.password, "bad"),
    ).toBe(false);
  });
  it("[security] accepts only exact bounded Basic credentials, never bearer/query/account passwords", () => {
    const secret = createCalendarFeedSecret(),
      basic = `Basic ${btoa(`${secret.id}:${secret.password}`)}`;
    expect(parseCalendarFeedAuthorization(basic)).toEqual({
      id: secret.id,
      password: secret.password,
    });
    for (const bad of [
      null,
      "",
      `Bearer ${secret.password}`,
      `${basic} extra`,
      basic + "\r\nX-Injected:1",
      "Basic !!!",
      `Basic ${btoa(`user:${secret.password}`)}`,
      `Basic ${btoa(`${secret.id}:account-password`)}`,
      `Basic ${"a".repeat(300)}`,
    ])
      expect(parseCalendarFeedAuthorization(bad)).toBeNull();
  });
  it("[unit] defaults30days and refuses expiry beyond90days or noncanonical dates", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    expect(calendarFeedExpiry(now)).toBe("2026-11-24T12:00:00.000Z");
    expect(calendarFeedExpiry(now, "2027-01-23T12:00:00.000Z")).toBe(
      "2027-01-23T12:00:00.000Z",
    );
    for (const bad of [
      "2027-01-24T12:00:00.000Z",
      "2026-10-25T12:00:00.000Z",
      "bad",
      "2026-11-24",
    ])
      expect(() => calendarFeedExpiry(now, bad)).toThrow("within 90 days");
  });
});
