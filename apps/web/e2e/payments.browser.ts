import { expect, test } from "@playwright/test";
import {
  summarizeStaffPayments,
  type PaymentRun,
  type PaymentRunReport,
} from "@ezacto/core";
const email = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!;
const password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!;
test.beforeEach(async ({ request }) => {
  const reset = await request.post("/__ezacto_browser_fixture__/start-end", {
    data: { action: "payment-run-reset" },
    headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
  });
  expect(reset.status()).toBe(204);
});
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
  let previews = 0;
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
    previews++;
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
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Balances", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-run-form]")).toBeHidden();
  const balancesTab = page.getByRole("tab", { name: "Balances", exact: true });
  await balancesTab.focus();
  await balancesTab.press("End");
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }),
  ).toBeFocused();
  await expect(page.locator("[data-payment-panel=settings]")).toBeVisible();
  await page.getByRole("tab", { name: "Settings", exact: true }).press("Home");
  await expect(balancesTab).toBeFocused();
  await expect(page.locator("[data-payment-runs]")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Pay now", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Pay now: Payment Fixture", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Send or schedule", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const form = page.locator("[data-run-form]");
  await expect(
    form.getByLabel("Pay Payment Fixture", { exact: true }),
  ).toBeChecked();
  expect(approved).toBe(false);
  expect(previews).toBe(0);
  await expect(form.getByLabel("Run name")).toHaveValue(
    "Payment Fixture · 2026-08",
  );
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
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(review).toBeHidden();
  await page
    .getByRole("tab", { name: "Send or schedule", exact: true })
    .click();
  await expect(review).toBeVisible();
  await expect(review).toContainText("USD 50.50");
  expect(previews).toBe(1);
  await page.screenshot({
    path: "/tmp/ezacto-payment-review.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Hide money amounts ($)", exact: true })
    .click();
  await expect(review.locator(".money").first()).toHaveCSS(
    "visibility",
    "hidden",
  );
  await page
    .getByRole("button", { name: "Show money amounts ($)", exact: true })
    .click();
  await expect(review.locator(".money").first()).toHaveCSS(
    "visibility",
    "visible",
  );
  await review.getByRole("button", { name: /Schedule 1 payment ·/ }).click();
  await expect(page.locator("[data-run-status]")).toHaveText("");
  await expect.poll(() => approved).toBe(true);
  await expect(
    page.getByRole("tab", { name: "History", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-run-history]")).toBeVisible();
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

test('[e2e:payments] reviews actual hours before confirming earnings and handing off to Pay now',async({page})=>{
  let saved=false,previews=0
  await page.route('**/api/v1/staff-payments?*',route=>route.fulfill({json:{data:{...ledger,rows:[{...row,amount_cents:saved?5000:null,balance_cents:saved?5000:null,available_cents:saved?5000:null,version:saved?1:0}]}}}))
  await page.route('**/api/v1/payment-runs/report?*',route=>route.fulfill({json:{data:{from:'2026-08',to:'2026-08',ledgers:[ledger],runs:[]}}}))
  await page.route('**/api/v1/staff-payments/actuals?*',route=>route.fulfill({json:{data:{month:'2026-08',currency:'USD',completed:true,people:[{user_id:2,name:row.name,entries:[{entry_id:10,project_id:1,project_name:'Actuals project',spent_date:'2026-08-10',rounded_seconds:7200,cost_rate_cents:5000,selected_seconds:7200}]}]}}}))
  await page.route('**/api/v1/staff-payments/actuals',route=>{
    const body=route.request().postDataJSON()
    expect(body.entries[0].selected_seconds).toBe(3600);expect(body.month).toBe('2026-08');expect(body.expected_version).toBe(0)
    saved=true;return route.fulfill({status:204})
  })
  await page.route('**/api/v1/payment-runs/preview',route=>{previews++;return route.fulfill({status:500})})
  await page.goto('/payments?month=2026-08')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(email);await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('tab',{name:'Review actuals',exact:true}).click()
  await page.getByRole('button',{name:'Load actuals for work month'}).click()
  await expect(page.locator('[data-actuals-total]')).toContainText('USD 100.00')
  await page.getByLabel('Included hours for Actuals project 2026-08-10 entry 10').fill('1')
  await expect(page.locator('[data-actuals-total]')).toContainText('USD 50.00')
  const project=page.getByRole('checkbox',{name:'Actuals project',exact:true})
  await expect(project).toHaveJSProperty('indeterminate',true)
  await project.check();await expect(page.locator('[data-actuals-total]')).toContainText('USD 100.00')
  await project.uncheck();await expect(page.locator('[data-actuals-total]')).toContainText('USD 0.00')
  await project.check();await page.getByLabel('Included hours for Actuals project 2026-08-10 entry 10').fill('1')
  expect(saved).toBe(false);expect(previews).toBe(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.getByRole('button',{name:'Confirm earnings',exact:true}).click()
  await expect(page.locator('[data-actuals-status]')).toHaveText('Earnings saved. No money has been sent.')
  expect(previews).toBe(0)
  await page.locator('[data-payment-actuals]').getByRole('button',{name:'Pay now',exact:true}).click()
  await expect(page.getByRole('tab',{name:'Send or schedule',exact:true})).toHaveAttribute('aria-selected','true')
  await expect(page.locator('[data-run-form]')).toBeVisible()
  expect(previews).toBe(0)
})

test('[e2e:advances] reviews a deposit, waits for settlement and applies credit without a second transfer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let approved = 0, applications = 0;
  const advanceRun = { ...run, name: 'Deposit', items: run.items.map((i) => ({ ...i, purpose: 'advance', advance_reason: 'Deposit before work', amount_cents: 15000, quote: { ...i.quote, target_cents: 15000, source_cents: 15050 } })) };
  const credit = { advance_item_id: 'payment', user_id: 2, name: row.name, currency: 'USD', month: row.month, advance_project_id: null, advance_reason: 'Deposit before work', state: 'queued', amount_cents: 15000,
    settled_cents: 0, settled_at: null as string | null, applied_cents: 0, returned_cents: 0, reserved_cents: 15000, available_cents: 0, opening_cents: 0, period_settled_cents: 0, period_applied_cents: 0, period_returned_cents: 0, closing_cents: 0, applications: [], returns: [] };
  await page.route('**/api/v1/staff-payments?*', (route) => route.fulfill({ json: { data: ledger } }));
  await page.route('**/api/v1/payment-runs/report?*', (route) => route.fulfill({ json: { data: { from: row.month, to: row.month, ledgers: [ledger], runs: [] } } }));
  await page.route('**/api/v1/payment-runs/preview', (route) => {
    expect(route.request().postDataJSON().items[0]).toMatchObject({ purpose: 'advance', user_id: 2, amount_cents: 15000, currency: 'USD', advance_reason: 'Deposit before work' });
    return route.fulfill({ status: 201, json: { data: advanceRun } });
  });
  await page.route('**/api/v1/payment-runs/run/approve', (route) => {
    approved++;
    return route.fulfill({ json: { data: { ...advanceRun, state: 'approved' } } });
  });
  await page.route('**/api/v1/payment-runs/advances?*', (route) => route.fulfill({ json: { data: { from: '2026-10-01', to: '2026-10-31', advances: [credit] } } }));
  await page.route('**/api/v1/staff-payments/allocations?*', (route) => route.fulfill({ json: { data: { month: row.month, people: [{ user_id: 2, name: row.name, currency: 'USD', remaining_cents: 10000, projects: [] }] } } }));
  await page.route('**/api/v1/payment-runs/advances/applications', (route) => {
    applications++;
    expect(route.request().postDataJSON()).toMatchObject({ advance_item_id: 'payment', user_id: 2, currency: 'USD', month: row.month, amount_cents: 4000, scope: 'month', reason: 'Apply deposit to reviewed work' });
    credit.applied_cents = 4000; credit.available_cents = 11000; credit.closing_cents = 11000;
    return route.fulfill({ status: 204 });
  });
  await page.goto('/payments?month=2026-08');
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('tab', { name: 'Advances', exact: true }).click();
  const panel = page.locator('[data-payment-advances]');
  await panel.getByText('Prepare an advance transfer', { exact: true }).click();
  await panel.getByLabel('Advance amount', { exact: true }).fill('150');
  await panel.getByLabel('Advance reason', { exact: true }).fill('Deposit before work');
  await panel.getByRole('button', { name: 'Review advance transfer', exact: true }).click();
  await expect(panel.getByText(/Verified Wise recipient: Verified Wise Person/)).toBeVisible();
  expect(approved).toBe(0);
  await panel.getByRole('button', { name: 'Confirm advance transfer', exact: true }).click();
  await expect(panel.getByRole('table', { name: 'Contractor advance credit' })).toContainText('queued');
  await expect(panel.getByRole('button', { name: 'Load eligible earnings' })).toHaveCount(0);
  credit.state = 'paid'; credit.settled_at = '2026-10-01T12:00:00.000Z'; credit.settled_cents = 15000; credit.period_settled_cents = 15000; credit.closing_cents = 15000; credit.reserved_cents = 0; credit.available_cents = 15000;
  await panel.getByRole('button', { name: 'Load advance credit', exact: true }).click();
  await panel.getByText(`${row.name} · USD · ${row.month} advance`, { exact: true }).click();
  await panel.getByRole('button', { name: 'Load eligible earnings', exact: true }).click();
  await panel.getByLabel('Credit to apply', { exact: true }).fill('40');
  await panel.getByLabel('Application reason', { exact: true }).fill('Apply deposit to reviewed work');
  await panel.getByLabel('I reviewed the earnings and want to apply credit without sending another payment', { exact: true }).check();
  await panel.getByRole('button', { name: 'Apply advance credit', exact: true }).click();
  await expect(panel.getByRole('table', { name: 'Contractor advance credit' })).toContainText('110.00');
  expect(approved).toBe(1);
  expect(applications).toBe(1);
});

test("[e2e:payments #891] reports received invoices and credit without a second payment", async ({
  page,
}) => {
  const month = "2026-09";
  const balance = { ...row, month, paid_cents: 4000, balance_cents: 6000, available_cents: 6000 };
  const invoice = {
    id: 91,
    user_id: 2,
    month,
    currency: "EUR",
    reference: "CONTRACTOR-891",
    matched_cents: 0,
    flags: ["currency_mismatch"],
    line_flags: [[]],
    versions: [
      {
        command_id: "received",
        version: 0,
        month,
        currency: "EUR",
        kind: "received",
        lines: [
          {
            description: "Reviewed work",
            project_id: 7,
            entry_id: 31,
            seconds: 3600,
            rate_cents: 8000,
          },
        ],
        amount_cents: 8000,
        review_id: null,
        document_id: null,
        reason: "Received original",
        actor_id: 1,
        recorded_at: "2026-10-01T00:00:00Z",
        paid_cents_at_recording: 4000,
        has_payment_history: true,
      },
    ],
  };
  const credit = {
    advance_item_id: "DEPOSIT-891",
    user_id: 2,
    name: row.name,
    currency: "USD",
    month,
    advance_project_id: null,
    advance_reason: "Before work",
    state: "paid",
    amount_cents: 10000,
    settled_cents: 10000,
    settled_at: "2026-09-02T00:00:00Z",
    applied_cents: 4000,
    returned_cents: 1000,
    reserved_cents: 0,
    available_cents: 5000,
    opening_cents: 0,
    period_settled_cents: 10000,
    period_applied_cents: 4000,
    period_returned_cents: 1000,
    closing_cents: 5000,
    applications: [
      {
        id: "APPLY-891",
        advance_item_id: "DEPOSIT-891",
        user_id: 2,
        currency: "USD",
        month,
        amount_cents: 4000,
        scope: "entry",
        project_id: 7,
        entry_id: 31,
        reason: "Reviewed application",
        actor_id: 1,
        recorded_at: "2026-09-10T00:00:00Z",
        reversed_at: null,
        reversal_reason: null,
      },
    ],
    returns: [
      {
        id: "RETURN-891",
        advance_item_id: "DEPOSIT-891",
        amount_cents: 1000,
        reference: "REFUND-891",
        reason: "Unused funds",
        actor_id: 1,
        recorded_at: "2026-09-20T00:00:00Z",
      },
    ],
  };
  let financialWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/v1\/(payment-runs|staff-payments|staff-invoices)/u.test(request.url())
    )
      financialWrites++;
  });
  await page.route("**/api/v1/payment-runs/report?*", (route) =>
    route.fulfill({
      json: {
        data: {
          from: month,
          to: month,
          ledgers: [{ ...ledger, month, rows: [balance] }],
          runs: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/staff-payments/allocations?*", (route) =>
    route.fulfill({ json: { data: { month, people: [] } } }),
  );
  await page.route("**/api/v1/staff-invoices?*", (route) =>
    route.fulfill({
      json: {
        data: {
          month,
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
              invoices: [invoice],
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/v1/payment-runs/advances?*", (route) =>
    route.fulfill({ json: { data: { from: "2026-09-01", to: "2026-09-30", advances: [credit] } } }),
  );
  await page.goto("/payments/report");
  await page.locator("[data-sign-in-form]").getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const host = page.locator("[data-run-report-financials]");
  await expect(host.getByRole("table", { name: "Contractor invoices", exact: true })).toContainText(
    "CONTRACTOR-891",
  );
  await expect(
    host.getByRole("table", { name: "Contractor invoice lines", exact: true }),
  ).toContainText("31");
  await expect(
    host.getByRole("table", { name: "Advance credit statement", exact: true }),
  ).toContainText("DEPOSIT-891");
  await expect(
    host.getByRole("table", { name: "Credit applied to earnings", exact: true }),
  ).toContainText("APPLY-891");
  await expect(
    host.getByRole("table", { name: "Returned advance credit", exact: true }),
  ).toContainText("REFUND-891");
  await expect(page.locator("[data-run-report-totals]")).toContainText("40.00");
  const currency = page.locator("[data-run-report-form]").getByLabel("Currency", { exact: true });
  await currency.fill("EUR");
  await expect(host.getByRole("table", { name: "Contractor invoices", exact: true })).toContainText(
    "CONTRACTOR-891",
  );
  await expect(
    host.getByRole("table", { name: "Advance credit statement", exact: true }),
  ).not.toContainText("DEPOSIT-891");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export filtered CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("payments");
  expect(financialWrites).toBe(0);
});
