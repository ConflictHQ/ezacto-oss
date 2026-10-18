import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { migrateD1 } from "@ezacto/db/d1";
import { ensureRuntimeDatabaseReady } from "../src/runtime.js";
it("refuses D1 traffic initialization while restored privacy evidence remains quarantined", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    await migrateD1(db);
    await db
      .prepare(
        "INSERT INTO account_restore_quarantine(id,quarantined,updated_at) VALUES(1,1,'2026-10-09T00:00:00.000Z')",
      )
      .run();
    await expect(ensureRuntimeDatabaseReady(db)).rejects.toThrow(
      "privacy evidence must be reconciled",
    );
    await db
      .prepare("UPDATE account_restore_quarantine SET quarantined=0")
      .run();
    await expect(ensureRuntimeDatabaseReady(db)).resolves.toBeUndefined();
  } finally {
    await mf.dispose();
  }
}, 30000);
