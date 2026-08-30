import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import {
  createMoneyResourceRepository,
  type MoneyResourceDatabase,
} from "../../db/src/money-resources.js";
import { createApiApp } from "../src/app.js";
import type { ApiAuthentication, ApiTokenService } from "../src/auth.js";
import type { UserProfile } from "../src/context.js";
import {
  installMoneyResourceRoutes,
  type InvoiceGenerationCommand,
} from "../src/money-resources.js";

interface TestDatabase {
  orm: MoneyResourceDatabase;
  run(sql: string, ...params: unknown[]): Promise<void>;
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const seedTime = "2026-08-28T08:00:00.000Z";
const firstTime = "2026-08-28T09:00:00.000Z";
const secondTime = "2026-08-28T09:01:00.000Z";
const thirdTime = "2026-08-28T09:02:00.000Z";
const fourthTime = "2026-08-28T09:03:00.000Z";

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(":memory:");
  migrateContainer(sqlite);
  return {
    orm: createContainerDatabase(sqlite),
    run: async (statement, ...params) => {
      sqlite.prepare(statement).run(...params);
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      sqlite.prepare(statement).all(...params) as T[],
    close: async () => {
      sqlite.close();
    },
  };
};

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ["DB"],
  });
  const d1 = await miniflare.getD1Database("DB");
  await migrateD1(d1);
  return {
    orm: createD1Database(d1),
    run: async (statement, ...params) => {
      await d1
        .prepare(statement)
        .bind(...params)
        .run();
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(statement)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  };
};

const factories = [
  ["SQLite", async () => containerDatabase()],
  ["D1", d1Database],
] as const;

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, created_at, updated_at
    ) VALUES
      (1, 'Original', 'Sender', 'accounting', '[]', ?, ?),
      (2, 'Second', 'Actor', 'accounting', '[]', ?, ?)`,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO user_emails (
      id, user_id, address, verified_at, is_primary, created_at, updated_at
    ) VALUES (1, 1, 'original@example.test', ?, 1, ?, ?)`,
    seedTime,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES
      (1, 'Sanitized Client', 'USD', ?, ?),
      (2, 'Other Client', 'EUR', ?, ?)`,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO retainers (
      id, client_id, state, denomination, amount_cents, seconds,
      on_exhaustion, created_at, updated_at
    ) VALUES (1, 1, 'ongoing', 'money', 500, NULL, 'block', ?, ?)`,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, state,
      amount_cents, due_amount_cents, retainer_id,
      created_at, updated_at
    ) VALUES
      (1, 1, 'INV-DRAFT', 'USD', '2026-08-01', '2026-08-31', 'draft',
        0, 0, NULL, ?, ?),
      (2, 1, 'INV-RETAINER', 'USD', '2026-08-01', '2026-08-31', 'open',
        500, 500, 1, ?, ?),
      (3, 1, 'INV-PAYMENT', 'USD', '2026-08-01', '2026-08-31', 'draft',
        0, 0, NULL, ?, ?)`,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO retainer_ledger (
      id, retainer_id, kind, unit, amount, invoice_id, occurred_on, notes, created_at
    ) VALUES ('seed-deposit', 1, 'deposit', 'cents', 500, 2, '2026-08-28', NULL, ?)`,
    seedTime,
  );
  await database.run(
    `INSERT INTO estimates (
      id, client_id, created_by_user_id, number, purchase_order, subject, notes,
      currency, state, version, issue_date, sent_at, accepted_at,
      tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, amount_cents,
      tax_amount_cents, tax2_amount_cents, discount_amount_cents,
      created_at, updated_at
    ) VALUES
      (10, 1, 1, 'EST-ACCEPTED', 'PO-10', 'Accepted work', 'Terms from estimate',
       'USD', 'accepted', 2, '2026-08-01', ?, ?, 100000, NULL, 50000,
       158, 15, 0, 8, ?, ?),
      (11, 1, 1, 'EST-SENT', NULL, 'Sent work', NULL,
       'USD', 'sent', 0, '2026-08-01', ?, NULL, NULL, NULL, NULL,
       100, 0, 0, 0, ?, ?),
      (12, 1, 1, 'EST-DRAFT', NULL, 'Draft work', NULL,
       'USD', 'draft', 0, '2026-08-01', NULL, NULL, NULL, NULL, NULL,
       100, 0, 0, 0, ?, ?),
      (13, 1, 1, 'EST-ZERO-LINES', NULL, 'Zero line mismatch', NULL,
       'USD', 'accepted', 4, '2026-08-01', ?, ?, 100000, NULL, 50000,
       777, 70, 0, 20, ?, ?)`,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
    seedTime,
  );
  await database.run(
    `INSERT INTO estimate_line_items (
      estimate_id, position, kind, description, quantity, unit_price_cents,
      amount_cents, taxed, taxed2, created_at, updated_at
    ) VALUES (10, 0, 'Service', 'Fractional exact line', 1.5, 101, 152, 1, 0, ?, ?)`,
    seedTime,
    seedTime,
  );
};

const unimplementedTokenMethod = async (): Promise<never> => {
  throw new Error("unused token test method");
};

const tokens: ApiTokenService = {
  authenticate: async (token) =>
    token === "read-only"
      ? {
          tokenId: 1,
          userId: 1,
          profile: "accounting",
          scopes: ["invoices:read"],
        }
      : token === "full-money"
        ? {
            tokenId: 2,
            userId: 1,
            profile: "accounting",
            scopes: ["invoices:read", "invoices:write"],
          }
        : null,
  issue: unimplementedTokenMethod,
  list: unimplementedTokenMethod,
  revoke: unimplementedTokenMethod,
};

const profiles = new Set<UserProfile>([
  "member",
  "project_manager",
  "people_admin",
  "accounting",
  "executive_manager",
  "administrator",
]);

const authentication: ApiAuthentication = {
  tokens,
  sessions: {
    resolve: async (request) => {
      const requested = request.headers.get("x-test-profile") ?? "accounting";
      if (!profiles.has(requested as UserProfile)) return null;
      const userId = request.headers.get("x-test-user") === "2" ? 2 : 1;
      return {
        type: "user",
        userId,
        profile: requested as UserProfile,
        authentication: { kind: "session", sessionId: "money-test" },
      };
    },
  },
};

interface Harness {
  database: TestDatabase;
  service: ReturnType<typeof createMoneyResourceRepository>;
  request(path: string, init?: RequestInit): Promise<Response>;
  setTime(value: string): void;
}

const withReadInterleaving = (
  database: TestDatabase,
  targetResource: "invoice" | "estimate",
): MoneyResourceDatabase => {
  const orm = database.orm;
  const client = orm.$client;
  let interleaved = false;
  const mutate = async (): Promise<void> => {
    if (targetResource === "invoice") {
      await database.run(
        `INSERT INTO invoice_line_items (
          id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
          taxed, taxed2, created_at, updated_at
        ) VALUES (777001, 1, 0, 'Concurrent', 1, 101, 101, 0, 0, ?, ?)`,
        secondTime,
        secondTime,
      );
      await database.run(
        `UPDATE invoices SET amount_cents = 101, due_amount_cents = 101,
          version = 1, updated_at = ? WHERE id = 1`,
        secondTime,
      );
    } else {
      await database.run(
        `INSERT INTO estimate_line_items (
          id, estimate_id, position, kind, quantity, unit_price_cents, amount_cents,
          taxed, taxed2, created_at, updated_at
        ) VALUES (777002, 12, 0, 'Concurrent', 1, 200, 200, 0, 0, ?, ?)`,
        secondTime,
        secondTime,
      );
      await database.run(
        `UPDATE estimates SET amount_cents = 200, version = 1, updated_at = ? WHERE id = 12`,
        secondTime,
      );
    }
  };
  const proxiedClient =
    "batch" in client
      ? new Proxy(client, {
          get(native, property) {
            if (property === "batch") {
              return async (statements: Parameters<typeof native.batch>[0]) => {
                if (!interleaved) {
                  interleaved = true;
                  await mutate();
                }
                return native.batch(statements);
              };
            }
            const value = Reflect.get(native, property, native);
            return typeof value === "function" ? value.bind(native) : value;
          },
        })
      : new Proxy(client, {
          get(native, property) {
            if (property === "transaction") {
              return (operation: () => unknown) => {
                const transaction = native.transaction(operation);
                return () => {
                  if (!interleaved) {
                    interleaved = true;
                    if (targetResource === "invoice") {
                      native
                        .prepare(
                          `INSERT INTO invoice_line_items (
                            id, invoice_id, position, kind, quantity, unit_price_cents,
                            amount_cents, taxed, taxed2, created_at, updated_at
                          ) VALUES (777001, 1, 0, 'Concurrent', 1, 101, 101, 0, 0, ?, ?)`,
                        )
                        .run(secondTime, secondTime);
                      native
                        .prepare(
                          `UPDATE invoices SET amount_cents = 101, due_amount_cents = 101,
                            version = 1, updated_at = ? WHERE id = 1`,
                        )
                        .run(secondTime);
                    } else {
                      native
                        .prepare(
                          `INSERT INTO estimate_line_items (
                            id, estimate_id, position, kind, quantity, unit_price_cents,
                            amount_cents, taxed, taxed2, created_at, updated_at
                          ) VALUES (777002, 12, 0, 'Concurrent', 1, 200, 200, 0, 0, ?, ?)`,
                        )
                        .run(secondTime, secondTime);
                      native
                        .prepare(
                          `UPDATE estimates SET amount_cents = 200, version = 1,
                            updated_at = ? WHERE id = 12`,
                        )
                        .run(secondTime);
                    }
                  }
                  return transaction();
                };
              };
            }
            const value = Reflect.get(native, property, native);
            return typeof value === "function" ? value.bind(native) : value;
          },
        });
  return { ...orm, $client: proxiedClient } as MoneyResourceDatabase;
};

const harness = async (
  factory: () => Promise<TestDatabase>,
  onGenerate?: (input: InvoiceGenerationCommand) => void,
  interleave?: "invoice" | "estimate",
): Promise<Harness> => {
  const database = await factory();
  await seed(database);
  if (interleave === "invoice") {
    // This fixture simulates a fully committed competing command without
    // recreating D22 command/outbox plumbing; production retains the guard.
    await database.run("DROP TRIGGER invoices_d22_transition_guard");
  }
  let currentTime = firstTime;
  const service = createMoneyResourceRepository(
    interleave === undefined
      ? database.orm
      : withReadInterleaving(database, interleave),
  );
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installMoneyResourceRoutes(api, {
        service,
        cursorSigningKey: new TextEncoder().encode(
          "money-resource-cursor-key-32-byte",
        ),
        clock: () => currentTime,
        ...(onGenerate === undefined
          ? {}
          : {
              generation: {
                generate: async (input: InvoiceGenerationCommand) => {
                  onGenerate(input);
                  const invoice = await service.getInvoice(1);
                  if (invoice === null)
                    throw new Error("fixture invoice missing");
                  return invoice;
                },
              },
            }),
      }),
  });
  return {
    database,
    service,
    request: async (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", "http://localhost");
      if (!headers.has("x-test-profile"))
        headers.set("x-test-profile", "accounting");
      return app.request(path, { ...init, headers });
    },
    setTime: (value) => {
      currentTime = value;
    },
  };
};

const jsonRequest = (
  method: "POST" | "PATCH" | "DELETE",
  body: Record<string, unknown>,
  commandId?: string,
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(commandId === undefined ? {} : { "idempotency-key": commandId }),
  },
  body: JSON.stringify(body),
});

const responseData = async <T>(response: Response): Promise<T> =>
  ((await response.json()) as { data: T }).data;

const stableTestId = async (
  namespace: string,
  parentId: number,
  commandId: string,
): Promise<number> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode([namespace, parentId, commandId].join("\u001f")),
    ),
  );
  const digest = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Number.parseInt(digest.slice(0, 13), 16) + 1;
};

for (const [runtime, factory] of factories) {
  const slowRuntimeTimeout = runtime === "D1" ? 20_000 : undefined;

  describe(`money resource API (${runtime})`, () => {
    let active: Harness | undefined;

    afterEach(async () => active?.database.close());

    const setup = async (
      onGenerate?: (input: InvoiceGenerationCommand) => void,
      interleave?: "invoice" | "estimate",
    ): Promise<Harness> => {
      active = await harness(factory, onGenerate, interleave);
      return active;
    };

    it("[db] returns a self-consistent invoice header/line snapshot", async () => {
      const test = await setup(undefined, "invoice");
      expect(await test.service.getInvoice(1)).toMatchObject({
        id: 1,
        version: 1,
        amount_cents: 101,
        due_amount_cents: 101,
        updated_at: secondTime,
        line_items: [{ id: 777001, amount_cents: 101, updated_at: secondTime }],
      });
    });

    it("[db] returns a self-consistent estimate header/line snapshot", async () => {
      const test = await setup(undefined, "estimate");
      expect(await test.service.getEstimate(12)).toMatchObject({
        id: 12,
        version: 1,
        amount_cents: 200,
        updated_at: secondTime,
        line_items: [{ id: 777002, amount_cents: 200, updated_at: secondTime }],
      });
    });

    it("[api] snapshots estimate senders and replays a stable message command", async () => {
      const test = await setup();
      const oversizedRecipient = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest(
          "POST",
          {
            expected_version: 0,
            event_type: "send",
            recipients: [
              { name: "n".repeat(1_001), email: "client@example.test" },
            ],
          },
          "oversized-estimate-recipient",
        ),
      );
      expect(oversizedRecipient.status).toBe(422);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM estimate_messages WHERE estimate_id = 11",
        ),
      ).toEqual([{ count: 0 }]);

      const body = {
        expected_version: 0,
        event_type: "accept",
        recipients: [],
        subject: "Accepted",
        body: "Looks good",
        send_me_a_copy: true,
      };
      const first = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest("POST", body, "accept-estimate-11"),
      );
      expect(first.status).toBe(201);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(
        await responseData<{
          estimate: { state: string; version: number };
          message: { sent_by: string; sent_by_email: string };
        }>(first),
      ).toMatchObject({
        estimate: { state: "accepted", version: 1 },
        message: {
          sent_by: "Original Sender",
          sent_by_email: "original@example.test",
        },
      });

      const staleSameTimestamp = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest("POST", body, "accept-estimate-11-stale"),
      );
      expect(staleSameTimestamp.status).toBe(409);
      expect(await staleSameTimestamp.json()).toMatchObject({
        error: { code: "estimate_version_conflict" },
      });
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM estimate_messages WHERE estimate_id = 11",
        ),
      ).toEqual([{ count: 1 }]);

      await test.database.run(
        "UPDATE users SET first_name = 'Renamed', last_name = 'Person' WHERE id = 1",
      );
      test.setTime(fourthTime);
      const replay = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest("POST", body, "accept-estimate-11"),
      );
      expect(replay.status).toBe(201);
      expect(
        await responseData<{ message: { sent_by: string } }>(replay),
      ).toMatchObject({
        message: { sent_by: "Original Sender" },
      });
      const changedVersion = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest(
          "POST",
          { ...body, expected_version: 1 },
          "accept-estimate-11",
        ),
      );
      expect(changedVersion.status).toBe(409);
      expect(await changedVersion.json()).toMatchObject({
        error: { code: "command_id_reused" },
      });
      const secondActorRequest = jsonRequest(
        "POST",
        body,
        "accept-estimate-11",
      );
      const secondActor = await test.request("/api/v1/estimates/11/messages", {
        ...secondActorRequest,
        headers: {
          ...(secondActorRequest.headers as Record<string, string>),
          "x-test-user": "2",
        },
      });
      expect(secondActor.status).toBe(409);
      expect(await secondActor.json()).toMatchObject({
        error: { code: "command_id_reused" },
      });
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM estimate_messages WHERE estimate_id = 11",
        ),
      ).toEqual([{ count: 1 }]);

      const hostile = await test.request(
        "/api/v1/estimates/11/messages",
        jsonRequest(
          "POST",
          { ...body, event_id: "caller-owned", sequence: 3 },
          "hostile-estimate-event",
        ),
      );
      expect(hostile.status).toBe(422);
    }, 15_000);

    it("[api] atomically converts only an accepted estimate and replays one invoice event", async () => {
      const test = await setup();
      const body = {
        expected_version: 2,
        number: "INV-FROM-EST-10",
        issue_date: "2026-08-28",
        due_date: "2026-09-27",
        payment_terms: "net_30",
      };
      const converted = await test.request(
        "/api/v1/estimates/10/convert",
        jsonRequest("POST", body, "convert-estimate-10"),
      );
      expect(converted.status).toBe(201);
      expect(converted.headers.get("cache-control")).toBe("no-store");
      const first = await responseData<{
        invoice: {
          id: number;
          estimate_id: number;
          state: string;
          client_id: number;
          currency: string;
          amount_cents: number;
          due_amount_cents: number;
          line_items: Array<{
            quantity: number;
            unit_price_cents: number;
            amount_cents: number;
          }>;
        };
        event: { id: number; event_type: string };
      }>(converted);
      expect(first).toMatchObject({
        invoice: {
          estimate_id: 10,
          state: "draft",
          client_id: 1,
          currency: "USD",
          amount_cents: 158,
          due_amount_cents: 158,
          line_items: [
            { quantity: 1.5, unit_price_cents: 101, amount_cents: 152 },
          ],
        },
        event: { event_type: "invoice" },
      });
      expect(
        await test.database.rows(
          "SELECT state, version, updated_at FROM estimates WHERE id = 10",
        ),
      ).toEqual([{ state: "accepted", version: 3, updated_at: firstTime }]);
      const staleReopen = await test.request(
        "/api/v1/estimates/10/messages",
        jsonRequest(
          "POST",
          {
            expected_version: 2,
            event_type: "re-open",
            recipients: [],
            send_me_a_copy: false,
          },
          "stale-reopen-after-convert",
        ),
      );
      expect(staleReopen.status).toBe(409);
      expect(await staleReopen.json()).toMatchObject({
        error: { code: "estimate_version_conflict" },
      });

      test.setTime(fourthTime);
      const replay = await test.request(
        "/api/v1/estimates/10/convert",
        jsonRequest("POST", body, "convert-estimate-10"),
      );
      expect(replay.status).toBe(201);
      expect(await responseData(replay)).toEqual(first);
      expect(
        await test.database.rows<{ invoiceCount: number; eventCount: number }>(
          `SELECT
            (SELECT COUNT(*) FROM invoices WHERE estimate_id = 10) AS invoiceCount,
            (SELECT COUNT(*) FROM estimate_messages
              WHERE estimate_id = 10 AND event_type = 'invoice') AS eventCount`,
        ),
      ).toEqual([{ invoiceCount: 1, eventCount: 1 }]);
      expect(
        await test.database.rows<{
          eventType: string;
          commandId: string;
          eventCount: number;
          completed: number;
        }>(
          `SELECT event.event_type AS eventType, event.command_id AS commandId,
            receipt.completed,
            (SELECT COUNT(*) FROM event_outbox scoped
              WHERE scoped.aggregate_type = 'invoice'
                AND scoped.aggregate_id = event.aggregate_id) AS eventCount
           FROM event_outbox event
           JOIN estimate_command_ledger receipt
             ON receipt.invoice_id = event.aggregate_id
             AND receipt.command_id = event.command_id
           WHERE receipt.estimate_id = 10`,
        ),
      ).toEqual([
        {
          eventType: "invoice.created",
          commandId: "convert-estimate-10",
          eventCount: 1,
          completed: 1,
        },
      ]);
      await expect(
        test.database.run(
          `UPDATE estimate_command_ledger SET actor_user_id = 2
           WHERE estimate_id = 10 AND command_id = 'convert-estimate-10'`,
        ),
      ).rejects.toThrow(/causation is immutable/);
      await expect(
        test.database.run(
          `DELETE FROM estimate_command_ledger
           WHERE estimate_id = 10 AND command_id = 'convert-estimate-10'`,
        ),
      ).rejects.toThrow(/append-only/);

      const [originalReceipt] = await test.database.rows<
        Record<string, unknown>
      >(
        `SELECT * FROM estimate_command_ledger
         WHERE estimate_id = 10 AND command_id = 'convert-estimate-10'`,
      );
      const [originalInvoiceEvent] = await test.database.rows<
        Record<string, unknown>
      >(
        `SELECT * FROM estimate_messages
         WHERE estimate_id = 10 AND event_type = 'invoice'`,
      );
      if (originalReceipt === undefined || originalInvoiceEvent === undefined) {
        throw new Error("conversion provenance fixture is incomplete");
      }
      const receiptInsert = `INSERT OR REPLACE INTO estimate_command_ledger (
        estimate_id, command_id, command_kind, input_fingerprint, actor_user_id,
        expected_estimate_version, message_id, invoice_id, event_id, occurred_at
      ) VALUES (?, ?, 'estimate.convert', ?, 2, 2, ?, ?, ?, ?)`;
      const fingerprint = `sha256:${"f".repeat(64)}`;
      for (const values of [
        [
          10,
          "convert-estimate-10",
          fingerprint,
          900001,
          900002,
          "forged-event-a",
          firstTime,
        ],
        [
          10,
          "forged-command-message",
          fingerprint,
          originalReceipt.message_id,
          900003,
          "forged-event-b",
          firstTime,
        ],
        [
          10,
          "forged-command-invoice",
          fingerprint,
          900004,
          originalReceipt.invoice_id,
          "forged-event-c",
          firstTime,
        ],
        [
          10,
          "forged-command-event",
          fingerprint,
          900005,
          900006,
          originalReceipt.event_id,
          firstTime,
        ],
      ]) {
        await expect(
          test.database.run(receiptInsert, ...values),
        ).rejects.toThrow(/estimate command identity already exists/);
      }
      await expect(
        test.database.run(
          `INSERT OR REPLACE INTO estimate_messages (
            id, estimate_id, recipients, send_me_a_copy, event_type, created_at, updated_at
          ) VALUES (900007, 10, '[]', 0, 'invoice', ?, ?)`,
          firstTime,
          firstTime,
        ),
      ).rejects.toThrow(/estimate invoice event already exists/);
      expect(
        await test.database.rows<Record<string, unknown>>(
          `SELECT * FROM estimate_command_ledger
           WHERE estimate_id = 10 AND command_id = 'convert-estimate-10'`,
        ),
      ).toEqual([originalReceipt]);
      expect(
        await test.database.rows<Record<string, unknown>>(
          `SELECT * FROM estimate_messages
           WHERE estimate_id = 10 AND event_type = 'invoice'`,
        ),
      ).toEqual([originalInvoiceEvent]);

      const changedVersion = await test.request(
        "/api/v1/estimates/10/convert",
        jsonRequest(
          "POST",
          { ...body, expected_version: 3 },
          "convert-estimate-10",
        ),
      );
      expect(changedVersion.status).toBe(409);
      expect(await changedVersion.json()).toMatchObject({
        error: { code: "command_id_reused" },
      });

      const secondCommand = await test.request(
        "/api/v1/estimates/10/convert",
        jsonRequest("POST", body, "convert-estimate-10-again"),
      );
      expect(secondCommand.status).toBe(409);
      expect(await secondCommand.json()).toMatchObject({
        error: { code: "estimate_already_converted" },
      });

      const draft = await test.request(
        "/api/v1/estimates/12/convert",
        jsonRequest(
          "POST",
          { ...body, expected_version: 0, number: "INV-DRAFT-REJECTED" },
          "convert-draft-12",
        ),
      );
      expect(draft.status).toBe(409);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM invoices WHERE estimate_id = 12",
        ),
      ).toEqual([{ count: 0 }]);
    });

    it("[db] serializes divergent same-key conversion races and derives zero-line totals from lines", async () => {
      const test = await setup();
      const common = {
        expected_version: 4,
        issue_date: "2026-08-28",
        due_date: "2026-09-27",
        payment_terms: "net_30",
      };
      const [first, second] = await Promise.all([
        test.request(
          "/api/v1/estimates/13/convert",
          jsonRequest(
            "POST",
            { ...common, number: "INV-RACE-A" },
            "convert-estimate-13-race",
          ),
        ),
        test.request(
          "/api/v1/estimates/13/convert",
          jsonRequest(
            "POST",
            { ...common, number: "INV-RACE-B" },
            "convert-estimate-13-race",
          ),
        ),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      const loser = first.status === 409 ? first : second;
      expect(await loser.json()).toMatchObject({
        error: { code: "command_id_reused" },
      });
      expect(
        await responseData<{
          invoice: {
            amount_cents: number;
            due_amount_cents: number;
            tax_amount_cents: number;
            discount_amount_cents: number;
            line_items: unknown[];
          };
        }>(winner),
      ).toMatchObject({
        invoice: {
          amount_cents: 0,
          due_amount_cents: 0,
          tax_amount_cents: 0,
          discount_amount_cents: 0,
          line_items: [],
        },
      });
      expect(
        await test.database.rows<{
          receipts: number;
          events: number;
          outbox: number;
        }>(
          `SELECT
            (SELECT COUNT(*) FROM estimate_command_ledger WHERE estimate_id = 13) AS receipts,
            (SELECT COUNT(*) FROM estimate_messages
              WHERE estimate_id = 13 AND event_type = 'invoice') AS events,
            (SELECT COUNT(*) FROM event_outbox event
              JOIN invoices invoice ON invoice.id = event.aggregate_id
              WHERE invoice.estimate_id = 13 AND event.event_type = 'invoice.created') AS outbox`,
        ),
      ).toEqual([{ receipts: 1, events: 1, outbox: 1 }]);

      await test.database.run(
        "UPDATE estimates SET state = 'accepted' WHERE id = 12",
      );
      const identicalBody = {
        expected_version: 0,
        number: "INV-IDENTICAL-RACE",
        issue_date: "2026-08-28",
        due_date: "2026-09-27",
        payment_terms: "net_30",
      };
      const [identicalFirst, identicalSecond] = await Promise.all([
        test.request(
          "/api/v1/estimates/12/convert",
          jsonRequest(
            "POST",
            identicalBody,
            "convert-estimate-12-identical-race",
          ),
        ),
        test.request(
          "/api/v1/estimates/12/convert",
          jsonRequest(
            "POST",
            identicalBody,
            "convert-estimate-12-identical-race",
          ),
        ),
      ]);
      expect([identicalFirst.status, identicalSecond.status]).toEqual([
        201, 201,
      ]);
      expect(await responseData(identicalSecond)).toEqual(
        await responseData(identicalFirst),
      );
      expect(
        await test.database.rows<{
          receipts: number;
          events: number;
          outbox: number;
        }>(
          `SELECT
            (SELECT COUNT(*) FROM estimate_command_ledger WHERE estimate_id = 12) AS receipts,
            (SELECT COUNT(*) FROM estimate_messages
              WHERE estimate_id = 12 AND event_type = 'invoice') AS events,
            (SELECT COUNT(*) FROM event_outbox event
              JOIN invoices invoice ON invoice.id = event.aggregate_id
              WHERE invoice.estimate_id = 12 AND event.event_type = 'invoice.created') AS outbox`,
        ),
      ).toEqual([{ receipts: 1, events: 1, outbox: 1 }]);
    }, 15_000);

    it("[db] rejects a second system invoice event when imported provenance already exists", async () => {
      const test = await setup();
      await test.database.run(
        "UPDATE estimates SET state = 'accepted' WHERE id = 12",
      );
      await test.database.run(
        `INSERT INTO estimate_messages (
          estimate_id, recipients, send_me_a_copy, event_type, created_at, updated_at
        ) VALUES (12, '[]', 0, 'invoice', ?, ?)`,
        seedTime,
        seedTime,
      );
      const response = await test.request(
        "/api/v1/estimates/12/convert",
        jsonRequest(
          "POST",
          {
            expected_version: 0,
            number: "INV-DUPLICATE-EVENT",
            issue_date: "2026-08-28",
            due_date: "2026-09-27",
            payment_terms: "net_30",
          },
          "convert-estimate-12-existing-event",
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "estimate_already_converted" },
      });
      expect(
        await test.database.rows<{ invoices: number; events: number }>(
          `SELECT
            (SELECT COUNT(*) FROM invoices WHERE estimate_id = 12) AS invoices,
            (SELECT COUNT(*) FROM estimate_messages
              WHERE estimate_id = 12 AND event_type = 'invoice') AS events`,
        ),
      ).toEqual([{ invoices: 0, events: 1 }]);
    });

    it("[db] atomically chooses one winner between conversion and estimate lifecycle", async () => {
      const test = await setup();
      const [conversion, reopen] = await Promise.all([
        test.request(
          "/api/v1/estimates/13/convert",
          jsonRequest(
            "POST",
            {
              expected_version: 4,
              number: "INV-CONVERT-REOPEN-RACE",
              issue_date: "2026-08-28",
              due_date: "2026-09-27",
              payment_terms: "net_30",
            },
            "convert-reopen-race",
          ),
        ),
        test.request(
          "/api/v1/estimates/13/messages",
          jsonRequest(
            "POST",
            {
              expected_version: 4,
              event_type: "re-open",
              recipients: [],
              send_me_a_copy: false,
            },
            "reopen-convert-race",
          ),
        ),
      ]);
      expect([conversion.status, reopen.status].sort()).toEqual([201, 409]);
      const [estimate] = await test.database.rows<{
        state: string;
        version: number;
      }>("SELECT state, version FROM estimates WHERE id = 13");
      expect(estimate?.version).toBe(5);
      const artifacts = await test.database.rows<{
        invoices: number;
        invoiceEvents: number;
        reopenEvents: number;
      }>(`SELECT
        (SELECT count(*) FROM invoices WHERE estimate_id = 13) AS invoices,
        (SELECT count(*) FROM estimate_messages WHERE estimate_id = 13 AND event_type = 'invoice')
          AS invoiceEvents,
        (SELECT count(*) FROM estimate_messages WHERE estimate_id = 13 AND event_type = 're-open')
          AS reopenEvents`);
      expect(artifacts).toEqual(
        conversion.status === 201
          ? [{ invoices: 1, invoiceEvents: 1, reopenEvents: 0 }]
          : [{ invoices: 0, invoiceEvents: 0, reopenEvents: 1 }],
      );
      expect(estimate?.state).toBe(
        conversion.status === 201 ? "accepted" : "sent",
      );
    });

    it("[db] rolls back conversion before invoice creation when the stable event id is occupied", async () => {
      const test = await setup();
      await test.database.run(
        "UPDATE estimates SET state = 'accepted' WHERE id = 12",
      );
      const commandId = "convert-estimate-12-collision";
      const eventId = await stableTestId(
        "estimate-invoice-event",
        12,
        commandId,
      );
      await test.database.run(
        `INSERT INTO estimate_messages (
          id, estimate_id, recipients, send_me_a_copy, event_type, created_at, updated_at
        ) VALUES (?, 11, '[]', 0, 'accept', ?, ?)`,
        eventId,
        seedTime,
        seedTime,
      );
      const response = await test.request(
        "/api/v1/estimates/12/convert",
        jsonRequest(
          "POST",
          {
            expected_version: 0,
            number: "INV-COLLISION",
            issue_date: "2026-08-28",
            due_date: "2026-09-27",
            payment_terms: "net_30",
          },
          commandId,
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "command_id_reused" },
      });
      expect(
        await test.database.rows<{ invoices: number; lines: number }>(
          `SELECT
            (SELECT COUNT(*) FROM invoices WHERE estimate_id = 12) AS invoices,
            (SELECT COUNT(*) FROM invoice_line_items line
              JOIN invoices invoice ON invoice.id = line.invoice_id
              WHERE invoice.estimate_id = 12) AS lines`,
        ),
      ).toEqual([{ invoices: 0, lines: 0 }]);
    });

    it("[db] rolls back all conversion provenance when final receipt completion fails", async () => {
      const test = await setup();
      await test.database.run(
        "UPDATE estimates SET state = 'accepted' WHERE id = 12",
      );
      await test.database.run(
        `CREATE TRIGGER force_conversion_completion_failure
         BEFORE UPDATE OF completed ON estimate_command_ledger
         WHEN NEW.completed = 1
         BEGIN
           SELECT RAISE(ABORT, 'forced conversion completion failure');
         END`,
      );
      const response = await test.request(
        "/api/v1/estimates/12/convert",
        jsonRequest(
          "POST",
          {
            expected_version: 0,
            number: "INV-ROLLBACK",
            issue_date: "2026-08-28",
            due_date: "2026-09-27",
            payment_terms: "net_30",
          },
          "convert-estimate-12-forced-failure",
        ),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "internal_error", fields: [] },
      });
      expect(
        await test.database.rows<{
          invoices: number;
          lines: number;
          events: number;
          outbox: number;
          receipts: number;
        }>(
          `SELECT
            (SELECT COUNT(*) FROM invoices WHERE estimate_id = 12) AS invoices,
            (SELECT COUNT(*) FROM invoice_line_items line
              JOIN invoices invoice ON invoice.id = line.invoice_id
              WHERE invoice.estimate_id = 12) AS lines,
            (SELECT COUNT(*) FROM estimate_messages
              WHERE estimate_id = 12 AND event_type = 'invoice') AS events,
            (SELECT COUNT(*) FROM event_outbox
              WHERE command_id = 'convert-estimate-12-forced-failure') AS outbox,
            (SELECT COUNT(*) FROM estimate_command_ledger
              WHERE estimate_id = 12) AS receipts`,
        ),
      ).toEqual([{ invoices: 0, lines: 0, events: 0, outbox: 0, receipts: 0 }]);
      expect(
        await test.database.rows(
          "SELECT state, version, updated_at FROM estimates WHERE id = 12",
        ),
      ).toEqual([{ state: "accepted", version: 0, updated_at: seedTime }]);
    });

    it("[api] passes validated generation identity and domain input exactly to the future engine", async () => {
      const captured: InvoiceGenerationCommand[] = [];
      const test = await setup((command) => captured.push(command));
      const body = {
        client_id: 1,
        from: "2026-08-01",
        to: "2026-08-31",
        project_ids: [3, 9],
        time_summary_type: "task",
        expense_summary_type: "category",
      };
      const generated = await test.request("/api/v1/invoice-generations", {
        ...jsonRequest("POST", body, "generate-august-client-1"),
        headers: {
          ...jsonRequest("POST", {}, "generate-august-client-1").headers,
          authorization: "Bearer full-money",
        },
      });

      expect(generated.status).toBe(201);
      expect(generated.headers.get("cache-control")).toBe("no-store");
      expect(await responseData<{ id: number }>(generated)).toMatchObject({
        id: 1,
      });
      expect(captured).toEqual([
        {
          commandId: "generate-august-client-1",
          principal: {
            type: "user",
            userId: 1,
            profile: "accounting",
            managerGrants: [],
            authentication: {
              kind: "token",
              tokenId: 2,
              scopes: ["invoices:read", "invoices:write"],
            },
          },
          request: {
            clientId: 1,
            from: "2026-08-01",
            to: "2026-08-31",
            projectIds: [3, 9],
            timeSummaryType: "task",
            expenseSummaryType: "category",
          },
        },
      ]);

      const hostile = await test.request(
        "/api/v1/invoice-generations",
        jsonRequest("POST", { ...body, event_id: "caller-owned" }, "hostile"),
      );
      expect(hostile.status).toBe(422);
      expect(captured).toHaveLength(1);
    });

    it("[api] leaves state untouched and returns 503 until the generation engine is bound", async () => {
      const test = await setup();
      const generated = await test.request(
        "/api/v1/invoice-generations",
        jsonRequest(
          "POST",
          {
            client_id: 1,
            from: "2026-08-01",
            to: "2026-08-31",
            project_ids: [1],
            time_summary_type: "project",
            expense_summary_type: null,
          },
          "generation-not-bound",
        ),
      );
      expect(generated.status).toBe(503);
      expect(await generated.json()).toMatchObject({
        // The internal error is service_unavailable; the shared API boundary
        // deliberately redacts every 5xx code/message on the wire.
        error: { code: "internal_error", fields: [] },
      });
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM invoices",
        ),
      ).toEqual([{ count: 3 }]);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM invoice_command_ledger",
        ),
      ).toEqual([{ count: 0 }]);
    });

    it("[security] enforces profile and token scope ceilings before money access", async () => {
      const test = await setup();
      expect(
        (
          await test.request("/api/v1/invoices", {
            headers: { "x-test-profile": "member" },
          })
        ).status,
      ).toBe(403);

      const readable = await test.request("/api/v1/invoices", {
        headers: { authorization: "Bearer read-only" },
      });
      expect(readable.status).toBe(200);
      expect(readable.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await readable.json())).not.toContain(
        "input_fingerprint",
      );

      const denied = await test.request("/api/v1/invoices/1", {
        ...jsonRequest(
          "PATCH",
          { expected_version: 0, subject: "Denied" },
          "scope-denied",
        ),
        headers: {
          ...jsonRequest("PATCH", {}, "scope-denied").headers,
          authorization: "Bearer read-only",
        },
      });
      expect(denied.status).toBe(403);
      expect(
        await test.database.rows<{ subject: string | null }>(
          "SELECT subject FROM invoices WHERE id = 1",
        ),
      ).toEqual([{ subject: null }]);
    });

    it("[api] rejects server-owned invoice fields and missing command identity without mutation", async () => {
      const test = await setup();
      const direct = await test.request(
        "/api/v1/invoices/1",
        jsonRequest(
          "PATCH",
          {
            expected_version: 0,
            state: "paid",
            paid_at: firstTime,
            amount_cents: 999,
            event_id: "caller-event",
            aggregate_sequence: 88,
          },
          "server-fields",
        ),
      );
      expect(direct.status).toBe(422);

      const missingKey = await test.request(
        "/api/v1/invoices/1",
        jsonRequest("PATCH", { expected_version: 0, subject: "No key" }),
      );
      expect(missingKey.status).toBe(422);
      expect(
        await test.database.rows<{
          state: string;
          amount_cents: number;
          version: number;
        }>("SELECT state, amount_cents, version FROM invoices WHERE id = 1"),
      ).toEqual([{ state: "draft", amount_cents: 0, version: 0 }]);
      expect(
        await test.database.rows("SELECT * FROM invoice_command_ledger"),
      ).toHaveLength(0);
      expect(
        await test.database.rows("SELECT * FROM event_outbox"),
      ).toHaveLength(0);
    });

    it("[api] rejects blank invoice numbers and invalid resulting date order atomically", async () => {
      const test = await setup();
      const before = await test.database.rows(
        "SELECT number, issue_date, due_date, version, updated_at FROM invoices WHERE id = 1",
      );
      const blank = await test.request(
        "/api/v1/invoices/1",
        jsonRequest(
          "PATCH",
          { expected_version: 0, number: "   " },
          "blank-number",
        ),
      );
      expect(blank.status).toBe(422);
      const issueAfterDue = await test.request(
        "/api/v1/invoices/1",
        jsonRequest(
          "PATCH",
          { expected_version: 0, issue_date: "2026-09-01" },
          "invalid-resulting-date-order",
        ),
      );
      expect(issueAfterDue.status).toBe(422);
      const dueBeforeIssue = await test.request(
        "/api/v1/invoices/1",
        jsonRequest(
          "PATCH",
          { expected_version: 0, due_date: "2026-07-31" },
          "invalid-due-date-order",
        ),
      );
      expect(dueBeforeIssue.status).toBe(422);
      expect(
        await test.database.rows(
          "SELECT number, issue_date, due_date, version, updated_at FROM invoices WHERE id = 1",
        ),
      ).toEqual(before);
      expect(
        await test.database.rows(
          `SELECT command_id FROM invoice_command_ledger
           WHERE command_id IN ('blank-number','invalid-resulting-date-order','invalid-due-date-order')`,
        ),
      ).toEqual([]);
    });

    it("[api] derives line totals, replays commands, and freezes lifecycle sender snapshots", async () => {
      const test = await setup();
      const lineBody = {
        expected_version: 0,
        position: 0,
        kind: "Service",
        description: "Fractional exact work",
        quantity: 1.5,
        unit_price_cents: 101,
        taxed: false,
        taxed2: false,
        project_id: null,
      };
      const inserted = await test.request(
        "/api/v1/invoices/1/line-items",
        jsonRequest("POST", lineBody, "line-exact"),
      );
      expect(inserted.status).toBe(201);
      const first = await responseData<{
        invoice: {
          amount_cents: number;
          due_amount_cents: number;
          version: number;
        };
        command: { event_ids: string[] };
      }>(inserted);
      expect(first.invoice).toMatchObject({
        amount_cents: 152,
        due_amount_cents: 152,
        version: 1,
      });

      test.setTime(secondTime);
      const replay = await test.request(
        "/api/v1/invoices/1/line-items",
        jsonRequest("POST", lineBody, "line-exact"),
      );
      expect(replay.status).toBe(201);
      expect(
        (await responseData<typeof first>(replay)).command.event_ids,
      ).toEqual(first.command.event_ids);
      expect(
        await test.database.rows(
          "SELECT id FROM invoice_line_items WHERE invoice_id = 1",
        ),
      ).toHaveLength(1);
      expect(
        await test.database.rows(
          "SELECT id FROM event_outbox WHERE aggregate_id = 1",
        ),
      ).toHaveLength(1);

      const reused = await test.request(
        "/api/v1/invoices/1/line-items",
        jsonRequest("POST", { ...lineBody, quantity: 2 }, "line-exact"),
      );
      expect(reused.status).toBe(409);

      const sendBody = {
        command: "send",
        expected_version: 1,
        recipients: [{ name: "Client", email: "client@example.test" }],
        subject: "Original subject",
        body: "Original body",
        attach_pdf: true,
        send_me_a_copy: true,
        thank_you: false,
        reminder: true,
        send_reminder_on: "2026-08-30",
      };
      const sent = await test.request(
        "/api/v1/invoices/1/transitions",
        jsonRequest("POST", sendBody, "send-snapshot"),
      );
      expect(sent.status).toBe(201);
      const sentData = await responseData<{
        invoice: { state: string; version: number };
        command: { event_ids: string[] };
      }>(sent);
      expect(sentData.invoice).toMatchObject({ state: "open", version: 2 });

      await test.database.run(
        "UPDATE users SET first_name = 'Changed', last_name = 'Identity', updated_at = ? WHERE id = 1",
        thirdTime,
      );
      await test.database.run(
        "UPDATE user_emails SET is_primary = 0, invalidated_at = ?, updated_at = ? WHERE id = 1",
        thirdTime,
        thirdTime,
      );
      await test.database.run(
        `INSERT INTO user_emails (
          id, user_id, address, verified_at, is_primary, created_at, updated_at
        ) VALUES (2, 1, 'changed@example.test', ?, 1, ?, ?)`,
        thirdTime,
        thirdTime,
        thirdTime,
      );
      const retriedAfterIdentityChange = await test.request(
        "/api/v1/invoices/1/transitions",
        jsonRequest("POST", sendBody, "send-snapshot"),
      );
      expect(retriedAfterIdentityChange.status).toBe(201);
      expect(
        (
          await responseData<{
            command: { event_ids: string[] };
          }>(retriedAfterIdentityChange)
        ).command.event_ids,
      ).toEqual(sentData.command.event_ids);
      const messages = await responseData<Array<Record<string, unknown>>>(
        await test.request("/api/v1/invoices/1/messages"),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        sent_by: "Original Sender",
        sent_by_email: "original@example.test",
        sent_from: "Original Sender",
        sent_from_email: "original@example.test",
        recipients: [{ name: "Client", email: "client@example.test" }],
        subject: "Original subject",
        body: "Original body",
        attach_pdf: true,
        send_me_a_copy: true,
        reminder: true,
        send_reminder_on: "2026-08-30",
      });
    });

    it("[api] reconciles payment create/update/delete and rolls conflicts back", async () => {
      const test = await setup();
      expect(
        (
          await test.request(
            "/api/v1/invoices/3/line-items",
            jsonRequest(
              "POST",
              {
                expected_version: 0,
                position: 0,
                kind: "Service",
                quantity: 1,
                unit_price_cents: 200,
              },
              "payment-fixture-line",
            ),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await test.request(
            "/api/v1/invoices/3/transitions",
            jsonRequest(
              "POST",
              { command: "send", expected_version: 1 },
              "payment-fixture-send",
            ),
          )
        ).status,
      ).toBe(201);
      const recorded = await test.request(
        "/api/v1/invoices/3/payments",
        jsonRequest(
          "POST",
          {
            expected_version: 2,
            currency: "USD",
            amount_cents: 50,
            paid_date: "2026-08-28",
            notes: "First payment",
          },
          "payment-record",
        ),
      );
      expect(recorded.status).toBe(201);
      const recordedData = await responseData<{
        invoice: { state: string; due_amount_cents: number; version: number };
        command: { event_count: number; event_ids: string[] };
      }>(recorded);
      expect(recordedData.invoice).toMatchObject({
        state: "open",
        due_amount_cents: 150,
        version: 3,
      });
      expect(recordedData.command.event_count).toBe(2);
      const [payment] = await test.database.rows<{
        id: number;
        updated_at: string;
      }>("SELECT id, updated_at FROM invoice_payments WHERE invoice_id = 3");

      test.setTime(secondTime);
      const replay = await test.request(
        "/api/v1/invoices/3/payments",
        jsonRequest(
          "POST",
          {
            expected_version: 2,
            currency: "USD",
            amount_cents: 50,
            paid_date: "2026-08-28",
            notes: "First payment",
          },
          "payment-record",
        ),
      );
      expect(replay.status).toBe(201);
      expect(
        (await responseData<typeof recordedData>(replay)).command.event_ids,
      ).toEqual(recordedData.command.event_ids);

      const immutableCurrency = await test.request(
        `/api/v1/invoices/3/payments/${payment!.id}`,
        jsonRequest(
          "PATCH",
          {
            expected_version: 3,
            expected_updated_at: payment!.updated_at,
            amount_cents: 200,
            currency: "EUR",
            paid_date: "2026-08-28",
            notes: "Corrected",
          },
          "payment-update",
        ),
      );
      expect(immutableCurrency.status).toBe(422);
      expect(
        await test.database.rows(
          "SELECT command_id FROM invoice_command_ledger WHERE command_id = 'payment-update'",
        ),
      ).toEqual([]);
      expect(
        await test.database.rows(
          "SELECT currency, amount_cents FROM invoice_payments WHERE id = ?",
          payment!.id,
        ),
      ).toEqual([{ currency: "USD", amount_cents: 50 }]);

      const corrected = await test.request(
        `/api/v1/invoices/3/payments/${payment!.id}`,
        jsonRequest(
          "PATCH",
          {
            expected_version: 3,
            expected_updated_at: payment!.updated_at,
            amount_cents: 200,
            paid_date: "2026-08-28",
            notes: "Corrected",
          },
          "payment-update",
        ),
      );
      expect(corrected.status).toBe(200);
      expect(
        (await responseData<{ invoice: Record<string, unknown> }>(corrected))
          .invoice,
      ).toMatchObject({ state: "paid", due_amount_cents: 0, version: 4 });

      test.setTime(thirdTime);
      const removed = await test.request(
        `/api/v1/invoices/3/payments/${payment!.id}`,
        jsonRequest(
          "DELETE",
          { expected_version: 4, expected_updated_at: secondTime },
          "payment-delete",
        ),
      );
      expect(removed.status).toBe(200);
      expect(
        (await responseData<{ invoice: Record<string, unknown> }>(removed))
          .invoice,
      ).toMatchObject({ state: "open", due_amount_cents: 200, version: 5 });

      test.setTime(fourthTime);
      expect(
        (
          await test.request(
            `/api/v1/invoices/3/payments/${payment!.id}`,
            jsonRequest(
              "DELETE",
              { expected_version: 4, expected_updated_at: secondTime },
              "payment-delete",
            ),
          )
        ).status,
      ).toBe(200);

      const mismatch = await test.request(
        "/api/v1/invoices/1/payments",
        jsonRequest(
          "POST",
          {
            expected_version: 0,
            currency: "EUR",
            amount_cents: 10,
            paid_date: "2026-08-28",
          },
          "payment-currency-mismatch",
        ),
      );
      expect(mismatch.status).toBe(422);
      expect(
        await test.database.rows(
          "SELECT id FROM invoice_payments WHERE invoice_id = 1",
        ),
      ).toHaveLength(0);
      expect(
        await test.database.rows(
          "SELECT id FROM invoice_payments WHERE invoice_id = 3",
        ),
      ).toHaveLength(0);
    }, slowRuntimeTimeout);

    it("[api] returns retainer movement plus balance and makes retries stable", async () => {
      const test = await setup();
      const body = {
        invoice_id: 2,
        amount_cents: 200,
        occurred_on: "2026-08-28",
        notes: "Applied to invoice",
      };
      const disguisedDeposit = await test.request(
        "/api/v1/retainers/1/drawdowns",
        jsonRequest(
          "POST",
          { ...body, kind: "deposit" },
          "retainer-disguised-deposit",
        ),
      );
      expect(disguisedDeposit.status).toBe(422);
      expect(
        await test.database.rows(
          "SELECT id FROM retainer_ledger WHERE kind = 'drawdown'",
        ),
      ).toHaveLength(0);

      const drawn = await test.request(
        "/api/v1/retainers/1/drawdowns",
        jsonRequest("POST", body, "retainer-draw"),
      );
      expect(drawn.status).toBe(201);
      const first = await responseData<{
        entry: {
          id: string;
          retainer_id: number;
          invoice_id: number | null;
          amount: number;
          occurred_on: string;
          created_at: string;
        };
        balance: number;
        denomination: string;
      }>(drawn);
      expect(first).toMatchObject({
        entry: {
          retainer_id: 1,
          invoice_id: 2,
          amount: -200,
          occurred_on: "2026-08-28",
          created_at: firstTime,
        },
        balance: 300,
        denomination: "money",
      });

      test.setTime(secondTime);
      const replay = await test.request(
        "/api/v1/retainers/1/drawdowns",
        jsonRequest("POST", body, "retainer-draw"),
      );
      expect(replay.status).toBe(201);
      expect(await responseData(replay)).toEqual(first);
      expect(
        await test.database.rows(
          "SELECT id FROM retainer_ledger WHERE kind = 'drawdown'",
        ),
      ).toHaveLength(1);

      const reused = await test.request(
        "/api/v1/retainers/1/drawdowns",
        jsonRequest("POST", { ...body, amount_cents: 100 }, "retainer-draw"),
      );
      expect(reused.status).toBe(409);

      const overdraw = await test.request(
        "/api/v1/retainers/1/drawdowns",
        jsonRequest(
          "POST",
          { ...body, amount_cents: 301 },
          "retainer-overdraw",
        ),
      );
      expect(overdraw.status).toBe(409);
      expect(
        await test.database.rows(
          "SELECT id FROM retainer_ledger WHERE kind = 'drawdown'",
        ),
      ).toHaveLength(1);
      expect(
        await responseData<{ balance: number }>(
          await test.request("/api/v1/retainers/1"),
        ),
      ).toMatchObject({ balance: 300 });
      const ledger = await responseData<Array<Record<string, unknown>>>(
        await test.request("/api/v1/retainers/1/ledger"),
      );
      const drawnEntry = ledger.find((entry) => entry.id === first.entry.id);
      expect(drawnEntry).toMatchObject({
        retainer_id: 1,
        invoice_id: 2,
        occurred_on: "2026-08-28",
        created_at: firstTime,
      });
      expect(drawnEntry).not.toHaveProperty("retainerId");
      expect(drawnEntry).not.toHaveProperty("createdAt");

      const negativeAdjustment = await test.request(
        "/api/v1/retainers/1/ledger",
        jsonRequest(
          "POST",
          {
            kind: "adjustment",
            amount_cents: -50,
            occurred_on: "2026-08-29",
            notes: "Correct an over-credit",
          },
          "retainer-negative-adjustment",
        ),
      );
      expect(negativeAdjustment.status).toBe(201);
      expect(await responseData(negativeAdjustment)).toMatchObject({
        entry: { kind: "adjustment", amount: -50 },
        balance: 250,
      });
      const negativeReset = await test.request(
        "/api/v1/retainers/1/ledger",
        jsonRequest(
          "POST",
          { kind: "reset", amount_cents: -25, occurred_on: "2026-08-30" },
          "retainer-negative-reset",
        ),
      );
      expect(negativeReset.status).toBe(201);
      expect(await responseData(negativeReset)).toMatchObject({
        entry: { kind: "reset", amount: -25 },
        balance: 225,
      });
    });

    it("[api] durably replays retainer creates and preserves concurrent partial policy patches", async () => {
      const test = await setup();
      const input = {
        client_id: 1,
        denomination: "money",
        amount_cents: 1_000,
        period: "monthly",
        rollover: "carry",
      };
      const created = await test.request(
        "/api/v1/retainers",
        jsonRequest("POST", input, "create-retainer-stable"),
      );
      expect(created.status).toBe(201);
      const original = await responseData<{
        id: number;
        period: string;
        rollover: string;
        created_at: string;
      }>(created);

      test.setTime(secondTime);
      const [period, rollover] = await Promise.all([
        test.request(
          `/api/v1/retainers/${original.id}`,
          jsonRequest("PATCH", { period: "quarterly" }),
        ),
        test.request(
          `/api/v1/retainers/${original.id}`,
          jsonRequest("PATCH", { rollover: "expire" }),
        ),
      ]);
      expect([period.status, rollover.status]).toEqual([200, 200]);
      expect(
        await responseData(
          await test.request(`/api/v1/retainers/${original.id}`),
        ),
      ).toMatchObject({ period: "quarterly", rollover: "expire" });

      test.setTime(thirdTime);
      const replay = await test.request(
        "/api/v1/retainers",
        jsonRequest("POST", input, "create-retainer-stable"),
      );
      expect(replay.status).toBe(201);
      expect(await responseData(replay)).toEqual(original);
      const changed = await test.request(
        "/api/v1/retainers",
        jsonRequest(
          "POST",
          { ...input, amount_cents: 2_000 },
          "create-retainer-stable",
        ),
      );
      expect(changed.status).toBe(409);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT count(*) AS count FROM retainers",
        ),
      ).toEqual([{ count: 2 }]);
    });

    it("[db] rolls a create resource back when durable receipt insertion fails late", async () => {
      const test = await setup();
      await test.database.run(
        `CREATE TRIGGER force_retainer_create_receipt_failure
         BEFORE INSERT ON resource_create_commands
         WHEN NEW.command_kind = 'retainer.create'
         BEGIN SELECT RAISE(ABORT, 'forced create receipt failure'); END`,
      );
      const response = await test.request(
        "/api/v1/retainers",
        jsonRequest(
          "POST",
          { client_id: 1, denomination: "money", amount_cents: 500 },
          "forced-create-receipt-failure",
        ),
      );
      expect(response.status).toBe(500);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT count(*) AS count FROM retainers",
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await test.database.rows<{ count: number }>(
          "SELECT count(*) AS count FROM resource_create_commands",
        ),
      ).toEqual([{ count: 0 }]);
    });

    it("[api] validates recurring definitions and exposes complete CRUD", async () => {
      const test = await setup();
      const input = {
        client_id: 1,
        subject_template: "Monthly services",
        notes_template: "Thank you",
        every_n_months: 1,
        day_of_month: 15,
        next_issue_on: "2026-09-15",
        amount_config: {
          schema_version: 1,
          type: "fixed_lines",
          line_items: [
            {
              kind: "Service",
              description: null,
              quantity: 1.5,
              unit_price_cents: 101,
              taxed: false,
              taxed2: false,
              project_id: null,
            },
          ],
        },
        can_draw_from_retainer_id: 1,
      };
      const created = await test.request(
        "/api/v1/recurring-invoices",
        jsonRequest("POST", input, "recurring-create"),
      );
      expect(created.status).toBe(201);
      const original = await responseData<{
        id: number;
        subject_template: string;
        updated_at: string;
      }>(created);
      expect(original).toMatchObject({
        subject_template: "Monthly services",
        updated_at: firstTime,
      });

      test.setTime(secondTime);
      const invalid = await test.request(
        `/api/v1/recurring-invoices/${original.id}`,
        jsonRequest("PATCH", {
          ...input,
          amount_config: {
            schema_version: 1,
            type: "line_items_import",
            project_ids: [],
          },
        }),
      );
      expect(invalid.status).toBe(422);
      expect(
        await responseData<{ updated_at: string }>(
          await test.request(`/api/v1/recurring-invoices/${original.id}`),
        ),
      ).toMatchObject({ updated_at: firstTime });

      const updated = await test.request(
        `/api/v1/recurring-invoices/${original.id}`,
        jsonRequest("PATCH", {
          ...input,
          subject_template: "Quarterly services",
          every_n_months: 3,
        }),
      );
      expect(updated.status).toBe(200);
      expect(await responseData(updated)).toMatchObject({
        subject_template: "Quarterly services",
        every_n_months: 3,
        updated_at: secondTime,
      });
      test.setTime(thirdTime);
      const replay = await test.request(
        "/api/v1/recurring-invoices",
        jsonRequest("POST", input, "recurring-create"),
      );
      expect(replay.status).toBe(201);
      expect(await responseData(replay)).toEqual(original);
      const changedCreate = await test.request(
        "/api/v1/recurring-invoices",
        jsonRequest(
          "POST",
          { ...input, subject_template: "Changed create" },
          "recurring-create",
        ),
      );
      expect(changedCreate.status).toBe(409);
      expect(
        await responseData<unknown[]>(
          await test.request("/api/v1/recurring-invoices"),
        ),
      ).toHaveLength(1);

      expect(
        (
          await test.request(`/api/v1/recurring-invoices/${original.id}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204);
      expect(
        (await test.request(`/api/v1/recurring-invoices/${original.id}`))
          .status,
      ).toBe(404);
    });
  });
}
