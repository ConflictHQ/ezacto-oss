import { expect, test } from "@playwright/test";

test("[e2e:table-sort #852] keyboard sorting survives reload and navigation with natural estimate numbers", async ({
  page,
}) => {
  const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!;
  const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const estimates = ["EST-10", "EST-9", "EST-1315"].map((number, index) => ({
    id: index + 1,
    client_id: 1,
    number,
    subject: null,
    purchase_order: null,
    currency: "USD",
    state: "draft",
    version: 1,
    issue_date: "2026-10-01",
    amount_cents: 1000,
    expires_on: null,
    effective_expires_on: null,
    line_items: [],
  }));
  await page.route("**/api/v1/estimates?*", (route) =>
    route.fulfill({ json: { data: estimates, page: { next_cursor: null } } }),
  );
  await page.route("**/api/v1/estimates", (route) =>
    route.fulfill({ json: { data: estimates, page: { next_cursor: null } } }),
  );
  const reset = await page.request.post(
    "/__ezacto_browser_fixture__/start-end",
    {
      data: { action: "sign-in-rate-reset" },
      headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
    },
  );
  expect(reset.status()).toBe(204);
  await page.goto("/invoices/estimates");
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Email")
    .fill(fixtureEmail);
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Password", { exact: true })
    .fill(fixturePassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const number = () =>
    page.locator('[data-estimate-list] button[data-sort-column="number"]');
  const numbers = page.locator(
    '[data-estimate-list] tbody [data-column="number"]',
  );
  await expect(number()).toBeVisible();
  await number().focus();
  await page.keyboard.press("Enter");
  await expect(numbers).toHaveText(["EST-9", "EST-10", "EST-1315"]);
  await expect(number()).toBeFocused();
  await page.keyboard.press("Space");
  await expect(numbers).toHaveText(["EST-1315", "EST-10", "EST-9"]);
  await expect(
    page.locator('[data-estimate-list] th[data-column="number"]'),
  ).toHaveAttribute("aria-sort", "descending");
  await page.reload();
  await expect(numbers).toHaveText(["EST-1315", "EST-10", "EST-9"]);
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.goto("/invoices/estimates");
  await expect(numbers).toHaveText(["EST-1315", "EST-10", "EST-9"]);
});
