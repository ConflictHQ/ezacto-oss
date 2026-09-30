import { expect, test } from "@playwright/test";
import {
  summarizeStaffPayments,
  type PaymentRun,
  type PaymentRunReport,
} from "@ezacto/core";
const email = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!;
const password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!;
const row = {
  ...summarizeStaffPayments(
    { user_id: 2, name: "Payment Fixture", active: true, wise_ready: true },
    "2026-08",
    [],
    "2026-09-01",
  ),
  amount_cents: 10000,
  currency: "USD",
  balance_cents: 10000,
  reserved_cents: 0,
  available_cents: 10000,
  version: 1,
};
const ledger = {
  month: "2026-08",
  as_of: "2026-09-01",
  provider_settings: {
    default_provider: "wise" as const,
    version: 0,
    events: [],
  },
  rows: [row],
};
const run: PaymentRun = {
  id: "run",
  name: "August payroll",
  source_currency: "USD",
  scheduled_at: "2026-10-01T15:00:00.000Z",
  timezone: "America/Costa_Rica",
  state: "draft",
  actor_id: 1,
  approved_by: null,
  created_at: "2026-08-31T01:00:00.000Z",
  approved_at: null,
  request_id: "fixture",
  items: [
    {
      id: "payment",
      run_id: "run",
      user_id: 2,
      name: row.name,
      month: row.month,
      expected_version: 1,
      amount_cents: 5000,
      currency: "USD",
      destination: { id: 1, external_id: "456", kind: "account" },
      quote: {
        id: "quote",
        profile_id: "123",
        recipient_id: "456",
        recipient_name: "Verified Wise Person",
        source_currency: "USD",
        target_currency: "USD",
        target_cents: 5000,
        source_cents: 5050,
        fee_cents: 50,
        rate: 1,
        expires_at: "2026-08-31T02:00:00.000Z",
        estimated_arrival: null,
      },
      execution_quote: null,
      max_source_cents: 5050,
      state: "draft",
      transfer_id: null,
      provider_status: null,
      failure: null,
      attempts: 0,
      next_attempt_at: "2026-10-01T15:00:00.000Z",
      updated_at: "2026-08-31T01:00:00.000Z",
      version: 0,
      lease_token: null,
      lease_until: null,
    },
  ],
};
test("[e2e:payments] schedules only after review and exposes the filtered payments report", async ({
  page,
}) => {
  let approved = false;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/v1/staff-payments?*", (route) =>
    route.fulfill({ json: { data: ledger } }),
  );
  await page.route("**/api/v1/payment-runs/report?*", (route) =>
    route.fulfill({
      json: {
        data: {
          from: "2026-08",
          to: "2026-08",
          ledgers: [ledger],
          runs: approved
            ? [
                {
                  ...run,
                  state: "approved",
                  items: run.items.map((i) => ({ ...i, state: "queued" })),
                },
              ]
            : [],
        } satisfies PaymentRunReport,
      },
    }),
  );
  await page.route("**/api/v1/payment-runs/preview", (route) => {
    const body = route.request().postDataJSON() as {
      items: { amount_cents: number }[];
      scheduled_at: string;
    };
    expect(body.items[0]?.amount_cents).toBe(5000);
    expect(body.scheduled_at).toBe("2026-10-01T15:00:00.000Z");
    return route.fulfill({ status: 201, json: { data: run } });
  });
  await page.route("**/api/v1/payment-runs/run/approve", (route) => {
    approved = true;
    return route.fulfill({ json: { data: { ...run, state: "approved" } } });
  });
  await page.goto("/payments?month=2026-08");
  await page.locator("[data-sign-in-form]").getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  const form = page.locator("[data-run-form]");
  await form.getByLabel("Run name").fill("August payroll");
  await form.getByLabel("When", { exact: true }).selectOption("scheduled");
  await form.getByLabel("Start at").fill("2026-10-01T09:00");
  await form.getByLabel("Pay Payment Fixture", { exact: true }).check();
  await form
    .getByLabel("Amount for Payment Fixture", { exact: true })
    .fill("50.00");
  await form.getByRole("button", { name: "Review selected payments" }).click();
  const review = page.locator("[data-run-review]");
  await expect(review).toContainText("Verified Wise Person");
  await expect(review).toContainText("USD 50.50");
  expect(approved).toBe(false);
  await page.screenshot({
    path: "/tmp/ezacto-payment-review.png",
    fullPage: true,
  });
  await review.getByRole("button", { name: /Schedule 1 payment ·/ }).click();
  await expect(page.locator("[data-run-status]")).toHaveText("");
  await expect.poll(() => approved).toBe(true);
  await expect(page.locator("[data-run-history]")).toContainText(
    "Scheduled / queued",
  );
  expect(approved).toBe(true);
  await page.goto("/payments/report");
  await expect(
    page.getByRole("heading", { name: "Payments report", exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator("[data-run-report-transfers]")).toContainText(
    "Payment Fixture",
  );
  await page
    .locator("[data-run-report-form]")
    .getByLabel("Person", { exact: true })
    .fill("Nobody");
  await expect(page.locator("[data-run-report-balances]")).toContainText(
    "No matching balances.",
  );
});
