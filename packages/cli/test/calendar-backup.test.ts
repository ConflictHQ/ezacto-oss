import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBackup, restoreBackup } from "../src/backup.js";
import { migrateContainer } from "../../db/src/migrate.js";
import { createContainerDatabase } from "../../db/src/adapters.js";
import { createContainerSessionStore } from "../../db/src/sessions.js";
import { createCalendarConnectionStore } from "../../db/src/calendar-connections.js";
import { createCalendarSyncService } from "../../integrations/src/calendar-sync.js";
import { createCalendarGrantVault } from "@ezacto/core";
it("physical backup contains only encrypted custody; restore quarantines the old grant as manual cleanup", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ezacto-owned-calendar-backup-"),
  );
  try {
    const databasePath = join(directory, "source.sqlite"),
      db = new BetterSqlite3(databasePath),
      now = new Date().toISOString();
    migrateContainer(db);
    db.prepare(
      "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Admin','administrator','[]',?,?)",
    ).run(now, now);
    const authority = {
        userId: 1,
        sessionId: (await createContainerSessionStore(db).issue(1)).session.id,
      },
      store = createCalendarConnectionStore(createContainerDatabase(db)),
      key = new Uint8Array(32).fill(7);
    await (
      await createCalendarSyncService({ store, deploymentKey: key })
    ).completeOAuth(authority, "google", 0, {
      refreshToken: "BACKUP_PRIVATE_REFRESH_SENTINEL",
      scopes: ["calendar.readonly"],
    });
    const prior = (await store.read(1, "google"))!,
      priorNonce = await store.instance();
    db.close();
    const backup = await createBackup({
      databasePath,
      outputDirectory: directory,
    });
    expect(
      await readFile(
        join(backup.bundleDirectory, "tables/calendar_connections.csv"),
        "utf8",
      ),
    ).not.toContain("BACKUP_PRIVATE_REFRESH_SENTINEL");
    const target = join(directory, "restored.sqlite");
    await restoreBackup({
      bundleDirectory: backup.bundleDirectory,
      targetDatabasePath: target,
    });
    const restored = new BetterSqlite3(target);
    try {
      const custody = createCalendarConnectionStore(
          createContainerDatabase(restored),
        ),
        state = (await custody.read(1, "google"))!,
        vault = await createCalendarGrantVault(key);
      expect(await custody.instance()).not.toBe(priorNonce);
      expect(state.state).toBe("needs_reauth");
      expect(state.sealedGrant).toBeNull();
      const pending = restored
        .prepare("SELECT status,sealed_grant FROM calendar_cleanup_obligations")
        .get() as { status: string; sealed_grant: string };
      expect(pending.status).toBe("manual_required");
      expect(await vault.openGrant(pending.sealed_grant, prior)).toMatchObject({
        refreshToken: "BACKUP_PRIVATE_REFRESH_SENTINEL",
      });
      await expect(
        vault.openGrant(pending.sealed_grant, {
          ...prior,
          instance: await custody.instance(),
        }),
      ).rejects.toThrow("invalid");
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
