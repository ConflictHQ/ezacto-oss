import { expect, test } from "@playwright/test";
const headers = { "x-ezacto-browser-fixture-control": "start-end-round-trip" };
test("reviews native deposits, verifies unknown source honestly, and records payments only after explicit confirmation", async ({
  page,
  request,
}) => {
  expect(
    (
      await request.post("/__ezacto_browser_fixture__/start-end", {
        headers,
        data: { action: "bank-deposit-seed" },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/invoices/bank-deposits");
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Email", { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const screen = page.locator("[data-bank-deposits-page]");
  await expect(
    screen.getByRole("heading", { name: "Bank deposits", exact: true }),
  ).toBeVisible();
  await expect(screen.locator("[data-bank-list] button")).toHaveCount(4);
  const receipt = async () =>
    (
      await request.post("/__ezacto_browser_fixture__/start-end", {
        headers,
        data: { action: "bank-deposit-receipt" },
      })
    ).json();
  expect((await receipt()).payments).toHaveLength(0);
  await screen
    .locator("[data-bank-list]")
    .getByRole("button", { name: /Bank customer Final/ })
    .click();
  await screen
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(screen.locator("[data-bank-action-status]")).toContainText(
    "Payment confirmed and recorded",
  );
  await screen
    .locator("[data-bank-list]")
    .getByRole("button", { name: /Bank customer Unknown/ })
    .click();
  await expect(screen.locator("[data-bank-confirm]")).toBeHidden();
  await screen
    .getByLabel("I verified that the funds are posted and available.")
    .check();
  await screen
    .getByLabel(
      "I verified this is a customer payment, not our own transfer or a refund.",
    )
    .check();
  await screen
    .getByLabel("Verification reference", { exact: true })
    .fill("Owned bank statement reviewed during browser acceptance");
  await screen
    .getByRole("button", { name: "Record source verification", exact: true })
    .click();
  await expect(screen.locator("[data-bank-source-note]")).toContainText(
    "does not change the provider",
  );
  await screen
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(screen.locator("[data-bank-action-status]")).toContainText(
    "Payment confirmed and recorded",
  );
  await screen
    .locator("[data-bank-list]")
    .getByRole("button", { name: /Bank customer Overpayment/ })
    .click();
  const choice = await screen
    .locator("[data-bank-assign] option")
    .filter({ hasText: "BANK-Overpayment" })
    .getAttribute("value");
  await screen.locator("[data-bank-assign] select").selectOption(choice!);
  await screen
    .getByRole("button", { name: "Assign invoice", exact: true })
    .click();
  await expect(screen.locator("[data-bank-confirm]")).toBeVisible();
  await screen
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(screen.locator("[data-bank-action-status]")).toContainText(
    "overpayment",
  );
  await screen
    .getByLabel(
      "I reviewed and accept this payment exceeding the invoice balance.",
    )
    .check();
  await screen
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(screen.locator("[data-bank-action-status]")).toContainText(
    "Payment confirmed and recorded",
  );
  await screen
    .locator("[data-bank-list]")
    .getByRole("button", { name: /Bank customer Pending/ })
    .click();
  await expect(screen.locator("[data-bank-confirm]")).toBeHidden();
  await expect(screen.locator("[data-bank-verify]")).toBeHidden();
  await screen
    .getByRole("button", { name: "Reject deposit", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "Reopen for review", exact: true })
    .click();
  const result = await receipt();
  expect(
    result.payments.map((p: { amount_cents: number }) => p.amount_cents),
  ).toEqual([10000, 20000, 35000]);
  expect(
    result.deposits.filter(
      (d: { match_state: string }) => d.match_state === "confirmed",
    ),
  ).toHaveLength(3);
  const verifiedUnknown = result.deposits.find(
    (d: { provider_transaction_id: string }) =>
      d.provider_transaction_id === "browser-bank-Unknown",
  );
  expect(verifiedUnknown.source_status).toBe("unknown");
  expect(verifiedUnknown.verified_at).not.toBeNull();
  expect(
    result.deposits.find(
      (d: { provider_transaction_id: string }) =>
        d.provider_transaction_id === "browser-bank-Pending",
    ).match_state,
  ).toBe("unmatched");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ezacto-101-bank-review-phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("[data-sign-in-form]")).toBeVisible();
  await expect(screen.locator("[data-bank-list]")).not.toContainText(
    "Bank customer",
  );
  await expect(screen.locator("[data-bank-facts]")).toBeEmpty();
});
