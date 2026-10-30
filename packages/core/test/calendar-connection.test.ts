import { describe, expect, it } from "vitest";
import { createCalendarGrantVault } from "../src/calendar-connection.js";
const identity = {
  instance: "a".repeat(64),
  userId: 2,
  provider: "google" as const,
  generation: 1,
  credentialRevision: 1,
};
const grant = {
  refreshToken: "PRIVATE_REFRESH_SENTINEL",
  accessToken: "PRIVATE_ACCESS_SENTINEL",
  scopes: ["calendar.readonly"],
};
describe("calendar OAuth custody", () => {
  it("authenticates owner, provider, instance and both generations; no plaintext leaves the vault", async () => {
    const vault = await createCalendarGrantVault(new Uint8Array(32).fill(7));
    const sealed = await vault.sealGrant(grant, identity);
    expect(sealed).not.toContain("SENTINEL");
    expect(await vault.openGrant(sealed, identity)).toEqual(grant);
    for (const changed of [
      { userId: 3 },
      { provider: "microsoft" as const },
      { instance: "b".repeat(64) },
      { generation: 2 },
      { credentialRevision: 2 },
    ])
      await expect(
        vault.openGrant(sealed, { ...identity, ...changed }),
      ).rejects.toThrow("Calendar connection invalid");
    await expect(
      (await createCalendarGrantVault(new Uint8Array(32).fill(8))).openGrant(
        sealed,
        identity,
      ),
    ).rejects.toThrow("Calendar connection invalid");
    await expect(vault.openCursor(sealed, identity)).rejects.toThrow(
      "Calendar connection invalid",
    );
  });
  it("separates and seals opaque cursors and sanitizes malformed envelopes", async () => {
    const vault = await createCalendarGrantVault(new Uint8Array(32).fill(7)),
      cursor = "PRIVATE_CURSOR_SENTINEL";
    const sealed = await vault.sealCursor(cursor, identity);
    expect(sealed).not.toContain(cursor);
    expect(await vault.openCursor(sealed, identity)).toBe(cursor);
    await expect(
      vault.openGrant("{PRIVATE_SENTINEL", identity),
    ).rejects.toThrow(/^Calendar connection invalid\.$/);
  });
});
