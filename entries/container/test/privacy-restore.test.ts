import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  createContainerDatabase,
  migrateContainer,
  createAccountRetentionRepository,
  createAccountDeletionRequestRepository,
  createAccountClosureRepository,
} from "@ezacto/db";
import {
  quarantineRestoredDatabase,
  replayClosureHistory,
  releasePrivacyQuarantine,
} from "../src/privacy-restore.js";
import { prepareContainerDatabase } from "../src/runtime.js";
const at = "2026-10-09T00:00:00.000Z";
const opened: BetterSqlite3.Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
async function fixture() {
  const source = new BetterSqlite3(":memory:");
  opened.push(source);
  migrateContainer(source);
  source.exec(
    `INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,created_at,updated_at) VALUES(1,'Ada','Owner','administrator',1,'[]','${at}','${at}'),(2,'Pat','Person','member',1,'[]','${at}','${at}')`,
  );
  source.exec(
    `INSERT INTO user_passwords(user_id,credential_version,algorithm,iterations,salt,password_hash,created_at,updated_at) VALUES(2,1,'pbkdf2-sha256',600000,'${"B".repeat(22)}','${"C".repeat(43)}','${at}','${at}')`,
  );
  const db = createContainerDatabase(source);
  await createAccountRetentionRepository(db).publish({
    actorUserId: 1,
    expectedVersion: 0,
    now: at,
    policy: {
      frameworks: [],
      retained_records: [
        {
          category: "audit_and_security",
          reason: "Minimal security evidence for the restore fixture.",
          period: "Until reviewed release.",
          review_after_days: 30,
        },
      ],
      response_target_days: 14,
      operator_contact: "privacy@example.test",
      user_notice: "Close account access.",
      backup_handling: "Replay current evidence before restored access.",
      acknowledged: true,
    },
  });
  await createAccountDeletionRequestRepository(db).request({
    userId: 2,
    id: "request-one",
    expectedPolicyVersion: 1,
    now: at,
  });
  const target = new BetterSqlite3(source.serialize());
  opened.push(target);
  const closure = createAccountClosureRepository(db),
    preview = await closure.preview(1, "request-one");
  await closure.close({
    actorUserId: 1,
    id: "request-one",
    expectedVersion: preview.request_version,
    expectedPolicyVersion: 1,
    reviewToken: preview.review_token,
    acknowledged: true,
    now: at,
  });
  return { source, target };
}
it("quarantines an older snapshot and replays actual local closure before an explicit evidence release", async () => {
  const { source, target } = await fixture();
  expect(
    target.prepare("SELECT is_active FROM users WHERE id=2").get(),
  ).toEqual({ is_active: 1 });
  expect(target.prepare("SELECT * FROM user_passwords").all()).toHaveLength(1);
  quarantineRestoredDatabase(target);
  expect(() => prepareContainerDatabase(target)).toThrow(
    "privacy evidence must be reconciled",
  );
  expect(() =>
    releasePrivacyQuarantine(
      target,
      source,
      "Reviewed current downstream evidence in the protected restore ticket.",
    ),
  ).toThrow("replay");
  expect(replayClosureHistory(target, source).replayed).toBe(1);
  expect(target.prepare("SELECT * FROM user_passwords").all()).toHaveLength(0);
  expect(
    target
      .prepare("SELECT is_active,first_name,last_name FROM users WHERE id=2")
      .get(),
  ).toEqual({ is_active: 0, first_name: "Closed", last_name: "account" });
  expect(() =>
    target.prepare("UPDATE users SET is_active=1 WHERE id=2").run(),
  ).toThrow("cannot be reactivated");
  expect(() => prepareContainerDatabase(target)).toThrow(
    "privacy evidence must be reconciled",
  );
  releasePrivacyQuarantine(
    target,
    source,
    "Reviewed actual attachment, export, integration and backup removal evidence in the protected restore ticket.",
  );
  expect(
    target.prepare("SELECT quarantined FROM account_restore_quarantine").get(),
  ).toEqual({ quarantined: 0 });
});
it("refuses cross-instance or changed evidence and leaves failed replay quarantined", async () => {
  const { source, target } = await fixture();
  replayClosureHistory(target, source);
  source
    .prepare(
      "UPDATE account_retention_obligations SET decision='failed' WHERE area='backups'",
    )
    .run();
  expect(() =>
    releasePrivacyQuarantine(
      target,
      source,
      "Reviewed the original snapshot evidence only.",
    ),
  ).toThrow("changed");
  const stranger = new BetterSqlite3(":memory:");
  opened.push(stranger);
  migrateContainer(stranger);
  expect(() => replayClosureHistory(target, stranger)).toThrow("same instance");
  expect(
    target.prepare("SELECT quarantined FROM account_restore_quarantine").get(),
  ).toEqual({ quarantined: 1 });
});
