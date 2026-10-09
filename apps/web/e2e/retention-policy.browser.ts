import { expect, test } from "@playwright/test";

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL;
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD;
if (fixtureEmail === undefined || fixturePassword === undefined)
  throw new Error("Browser fixture credentials are required");

test("[e2e:retention] publishes and reloads an operator policy with a fresh acknowledgement", async ({
  page,
}) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.goto("/settings/company#erasure");
  const reset = await page.request.post(
    "/__ezacto_browser_fixture__/start-end",
    {
      data: { action: "sign-in-rate-reset" },
      headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
    },
  );
  expect(reset.status()).toBe(204);
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Email")
    .fill(fixtureEmail);
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Password")
    .fill(fixturePassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const form = page.locator("[data-retention-form]");
  await expect(form).toBeVisible();
  await form.getByLabel("Colorado Privacy Act", { exact: true }).check();
  const time = form.locator(
    '[data-retention-category="time_and_worker_attribution"]',
  );
  await time.getByLabel("Retain necessary records in this category").check();
  await time
    .getByLabel("Specific purpose and legal basis")
    .fill(
      "Necessary evidence of billed work for the applicable accounting obligation.",
    );
  await time
    .getByLabel(
      "Retention period and starting event, or hold release condition",
    )
    .fill(
      "Until the documented obligation for the invoice expires; review each request.",
    );
  await time.getByLabel("Review within (days)").fill("30");
  await form
    .getByLabel("Operator privacy contact")
    .fill("privacy@example.test");
  await form.getByLabel("Initial response target (days)").fill("14");
  await form
    .getByLabel("User disclosure", { exact: true })
    .fill(
      "Our operator closes accounts while retaining only justified identified work records. Contact us for status or appeal.",
    );
  await form
    .getByLabel("Backup and restore handling")
    .fill(
      "Review backup expiry and replay completed closures before restored data is made available.",
    );
  const acknowledgement = form.getByLabel("I have reviewed applicability", {
    exact: false,
  });
  await expect(acknowledgement).not.toBeChecked();
  await acknowledgement.check();
  await form.getByRole("button", { name: "Publish policy" }).click();
  await expect(page.locator("[data-retention-result]")).toContainText(
    "Policy published",
  );
  await page.reload();
  await expect(
    form.getByLabel("Colorado Privacy Act", { exact: true }),
  ).toBeChecked();
  await expect(time.getByLabel("Review within (days)")).toHaveValue("30");
  await expect(acknowledgement).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
