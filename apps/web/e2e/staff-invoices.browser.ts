import { expect, test } from "@playwright/test";
import {
  summarizeStaffPayments,
  type StaffInvoice,
  type StaffInvoiceReport,
} from "@ezacto/core";
const email = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!,
  password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!;
test("[e2e:staff-invoices] records a draft, reviews a received mismatch and attaches a versioned document without another payment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const row = {
    ...summarizeStaffPayments(
      { user_id: 2, name: "Invoice Fixture", active: true, wise_ready: true },
      "2026-09",
      [],
      "2026-10-01",
    ),
    is_contractor: true,
    currency: "USD",
    amount_cents: 10000,
    paid_cents: 4000,
    balance_cents: 6000,
  };
  const ledger = {
    month: "2026-09",
    as_of: "2026-10-01",
    provider_settings: { default_provider: "wise", version: 0, events: [] },
    rows: [row],
  };
  const report: StaffInvoiceReport = {
    month: "2026-09",
    people: [
      {
        user_id: 2,
        name: row.name,
        currency: "USD",
        earned_cents: 10000,
        paid_cents: 4000,
        invoiced_cents: 0,
        matched_invoice_cents: 0,
        uninvoiced_cents: 10000,
        invoices: [],
      },
    ],
  };
  let writes = 0,
    uploads = 0,
    unexpectedMoneyWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/payment-runs\/.*approve|\/staff-payments(?:\/events)?$/u.test(
        new URL(request.url()).pathname,
      )
    )
      unexpectedMoneyWrites++;
  });
  await page.route("**/api/v1/staff-payments?*", (route) =>
    route.fulfill({ json: { data: ledger } }),
  );
  await page.route("**/api/v1/payment-runs/report?*", (route) =>
    route.fulfill({
      json: {
        data: { from: "2026-09", to: "2026-09", ledgers: [ledger], runs: [] },
      },
    }),
  );
  await page.route("**/api/v1/staff-invoices?*", (route) =>
    route.fulfill({ json: { data: report } }),
  );
  await page.route("**/api/v1/staff-invoices", (route) => {
    const command = route.request().postDataJSON();
    writes++;
    const previous = report.people[0]!.invoices[0],
      version = command.expected_version + 1;
    expect(command.user_id).toBe(2);
    expect(command.reference).toBe("C-001");
    expect(command.expected_version).toBe(writes - 1);
    const lines = command.from_review
      ? [
          {
            description: "Project work",
            project_id: 1,
            entry_id: 10,
            seconds: 7200,
            rate_cents: 5000,
          },
        ]
      : command.lines;
    const invoice: StaffInvoice = {
      id: 7,
      user_id: 2,
      month: "2026-09",
      currency: "USD",
      reference: "C-001",
      matched_cents: version === 1 ? 10000 : 0,
      flags: version === 1 ? [] : ["Hours exceed reviewed earning"],
      line_flags: [version === 1 ? [] : ["Hours exceed reviewed earning"]],
      versions: [
        ...(previous?.versions ?? []),
        {
          command_id: command.id,
          version,
          month: "2026-09",
          currency: "USD",
          kind: command.kind,
          lines,
          amount_cents: version === 1 ? 10000 : 15000,
          review_id: "review",
          document_id: command.document_id,
          reason: command.reason,
          actor_id: 1,
          recorded_at: "2026-10-01T12:00:00.000Z",
          paid_cents_at_recording: 4000,
          has_payment_history: true,
        },
      ],
    };
    report.people[0]!.invoices = [invoice];
    if (command.kind === "received") report.people[0]!.invoiced_cents = 15000;
    return route.fulfill({ status: 201, json: { data: invoice } });
  });
  await page.route("**/api/v1/staff-invoices/7/documents?*", (route) => {
    uploads++;
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    return route.fulfill({
      status: 201,
      json: {
        data: {
          id: "document",
          invoice_id: 7,
          name: "invoice.pdf",
          byte_size: 9,
          content_type: "application/pdf",
        },
      },
    });
  });
  await page.goto("/payments?month=2026-09");
  await page.locator("[data-sign-in-form]").getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("tab", { name: "Contractor invoices", exact: true })
    .click();
  const panel = page.locator("[data-staff-invoices]");
  await panel
    .getByRole("button", {
      name: "Load contractor invoices for work month",
      exact: true,
    })
    .click();
  await panel
    .getByRole("button", {
      name: "Draft or record contractor invoice",
      exact: true,
    })
    .click();
  await panel
    .getByLabel("Contractor invoice reference", { exact: true })
    .fill("C-001");
  await panel
    .getByLabel("Reason shared with contractor", { exact: true })
    .fill("Draft from reviewed earnings");
  await panel
    .getByRole("button", { name: "Record contractor invoice", exact: true })
    .click();
  await expect(panel.locator("[data-staff-invoice-editor]")).toBeEmpty();
  await panel.getByText(`Review ${row.name} · C-001`, { exact: true }).click();
  await panel
    .getByRole("button", { name: "Record corrected version", exact: true })
    .click();
  await panel
    .getByLabel("Contractor invoice state", { exact: true })
    .selectOption("received");
  await panel.getByLabel("Line hours", { exact: true }).fill("3");
  await panel
    .getByLabel("Reason shared with contractor", { exact: true })
    .fill("Received invoice differs from reviewed hours");
  await panel
    .getByLabel(
      "I reviewed existing payments; this document will not change them",
      { exact: true },
    )
    .check();
  await panel
    .getByRole("button", { name: "Record invoice correction", exact: true })
    .click();
  await expect(panel).toContainText("Hours exceed reviewed earning");
  await panel.getByText(`Review ${row.name} · C-001`, { exact: true }).click();
  await panel
    .getByLabel("Contractor invoice document", { exact: true })
    .setInputFiles({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("pdf bytes"),
    });
  await panel
    .getByLabel("Attachment reason shared with contractor", { exact: true })
    .fill("Attach received document");
  await panel
    .getByLabel("I reviewed payments before attaching this document", {
      exact: true,
    })
    .check();
  await panel
    .getByRole("button", { name: "Attach invoice document", exact: true })
    .click();
  await expect(panel.locator("[data-staff-invoice-status]")).toHaveText(
    "Document attached in a new immutable invoice version.",
  );
  expect(writes).toBe(3);
  expect(uploads).toBe(1);
  expect(unexpectedMoneyWrites).toBe(0);
});
