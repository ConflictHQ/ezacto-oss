import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  createBankDepositIngestionService,
  createContainerDatabase,
  executeInvoiceLifecycleCommand,
} from "@ezacto/db";
import {
  createContainerRuntime,
  type ContainerRuntime,
} from "../src/runtime.js";
import { createContainerHandler } from "../src/handler.js";
import { createApp } from "../../worker/src/app.js";
it("stages a feed credit and confirms it through native Container session APIs", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bank-review-owned-")),
  );
  let runtime: ContainerRuntime | undefined;
  try {
    const config = {
      host: "127.0.0.1",
      port: 3000,
      trustedProxyHops: 0,
      dataDirectory: root,
      databasePath: join(root, "db.sqlite"),
      attachmentDirectory: join(root, "attachments"),
      brandDirectory: join(root, "brand"),
      appBaseUrl: "http://localhost:3000",
      cursorSigningKey: new Uint8Array(32).fill(31),
      smtp: { url: "smtp://localhost:2525", from: "owned@example.test" },
      appEnv: { ENVIRONMENT: "test", RELEASE: "owned-bank-review" },
    };
    runtime = await createContainerRuntime(config, {
      emailProvider: {
        name: "smtp",
        send: async () => ({ messageId: "owned", latencyMs: 0 }),
      },
    });
    await runtime.services.bootstrap({
      organizationName: "Owned",
      ownerFirstName: "Owned",
      ownerLastName: "Admin",
      ownerEmail: "owned@example.test",
      token: `ezacto_${randomBytes(12).toString("base64url")}_${randomBytes(32).toString("base64url")}`,
    });
    const session = await runtime.services.sessions.issue(1),
      cookie = session.setCookie.split(";")[0]!;
    const handler = createContainerHandler(
      runtime.services,
      createApp(runtime.services),
      config.appEnv,
    );
    let next = 0;
    const request = (path: string, body?: unknown) =>
      handler(
        new Request(config.appBaseUrl + "/api/v1" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie,
            origin: config.appBaseUrl,
            "content-type": "application/json",
            "Idempotency-Key": "owned-" + ++next,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const client = (await (
      await request("/clients", { name: "Owned customer", currency: "USD" })
    ).json()) as { data: { id: number } };
    const invoice = (await (
      await request("/invoice-generations", {
        kind: "free_form",
        client_id: client.data.id,
      })
    ).json()) as { data: { id: number; version: number } };
    const line = (await (
      await request(`/invoices/${invoice.data.id}/line-items`, {
        expected_version: invoice.data.version,
        position: 0,
        kind: "Service",
        description: "Owned work",
        quantity: 1,
        unit_price_cents: 10000,
        taxed: false,
        taxed2: false,
      })
    ).json()) as { data: { version: number } };
    expect(line.data).toBeDefined();
    const db = createContainerDatabase(runtime.database),
      now = new Date().toISOString();
    await executeInvoiceLifecycleCommand(db, {
      invoiceId: invoice.data.id,
      commandId: "owned-send",
      command: "send",
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: (
        runtime.database
          .prepare("SELECT version FROM invoices WHERE id=?")
          .get(invoice.data.id) as { version: number }
      ).version,
      occurredAt: now,
      messageId: 1,
      eventId: "owned-sent",
    });
    const ingest = createBankDepositIngestionService(db),
      account = await ingest.ensureAccount({
        provider: "mercury",
        externalAccountId: "owned-account",
        name: "Owned feed",
      });
    await ingest.ingest({
      command_id: "owned-feed-page",
      account_id: account.id,
      deposits: [
        {
          provider_transaction_id: "owned-credit",
          currency: "USD",
          amount_cents: 10000,
          posted_at: now,
          memo: null,
          counterparty: "Owned customer",
        },
      ],
      observations: {
        "owned-credit": { status: "final", classification: "external_credit" },
      },
    });
    const list = await request("/bank-deposits");
    expect(list.status).toBe(200);
    const rows = (await list.json()) as {
      data: Array<{
        id: number;
        version: number;
        suggested_invoice: { id: number; version: number };
      }>;
    };
    expect(rows.data).toHaveLength(1);
    const deposit = rows.data[0]!;
    const confirmed = await request(`/bank-deposits/${deposit.id}/confirm`, {
      expected_version: deposit.version,
      invoice_id: deposit.suggested_invoice.id,
      expected_invoice_version: deposit.suggested_invoice.version,
      confirm_overpayment: false,
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(
      runtime.database
        .prepare("SELECT amount_cents FROM invoice_payments")
        .all(),
    ).toEqual([{ amount_cents: 10000 }]);
    expect(
      runtime.database
        .prepare(
          "SELECT count(*) AS n FROM bank_deposit_audit WHERE operation='confirm'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect((await request("/bank-feed-status")).status).toBe(200);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
