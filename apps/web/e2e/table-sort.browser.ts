import { expect, test } from "@playwright/test";

test("[e2e:table-sort #852] keyboard sorting preserves client hierarchy and remembers natural estimate numbers", async ({
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

  const clients = [
    { id: 10, name: "Root 10", parent_client_id: null },
    { id: 20, name: "Root 9", parent_client_id: null },
    { id: 11, name: "Unit 10", parent_client_id: 10 },
    { id: 12, name: "Unit 9", parent_client_id: 10 },
  ].map((client) => ({ ...client, is_active: true, bill_to_client_id: null }));
  for (const path of ["**/api/v1/clients", "**/api/v1/clients?*"])
    await page.route(path, (route) =>
      route.fulfill({ json: { data: clients, page: { next_cursor: null } } }),
    );
  await page.goto("/clients");
  const clientNames = page.locator(
    '[data-client-tree] tbody [data-column="client"] a',
  );
  const clientHeader = () =>
    page.locator('[data-client-tree] button[data-sort-column="client"]');
  await expect(clientNames).toHaveText([
    "Root 9",
    "Root 10",
    "Unit 9",
    "Unit 10",
  ]);
  await clientHeader().focus();
  await page.keyboard.press("Enter");
  await expect(clientNames).toHaveText([
    "Root 10",
    "Unit 10",
    "Unit 9",
    "Root 9",
  ]);
  await expect(clientHeader()).toBeFocused();
  await expect(
    page.locator('[data-client-tree] [data-row-key="11"] .client-tree-name'),
  ).toHaveCSS("padding-inline-start", "16px");
  await page.reload();
  await expect(clientNames).toHaveText([
    "Root 10",
    "Unit 10",
    "Unit 9",
    "Root 9",
  ]);
});
