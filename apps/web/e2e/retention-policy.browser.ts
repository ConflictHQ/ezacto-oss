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
  await form.locator("[data-privacy-states] summary").click();
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
  const audit = form.locator('[data-retention-category="audit_and_security"]');
  await audit.getByLabel("Retain necessary records in this category").check();
  await audit
    .getByLabel("Specific purpose and legal basis")
    .fill("Necessary request and security evidence, reviewed for each person.");
  await audit
    .getByLabel(
      "Retention period and starting event, or hold release condition",
    )
    .fill(
      "Review one year after closure and remove evidence no longer necessary.",
    );
  await audit.getByLabel("Review within (days)").fill("30");
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
  const requested = await page.evaluate(async () => {
    const policyResponse = await fetch("/api/v1/profile/retention-policy");
    if (!policyResponse.ok)
      throw new Error(`Policy response ${policyResponse.status}`);
    const published = await policyResponse.json();
    const asked = await fetch("/api/v1/profile/deletion-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_policy_version: published.data.version }),
    });
    if (asked.status !== 202)
      throw new Error(`Deletion request response ${asked.status}`);
    return asked.json();
  });
  expect(requested.data.policy_reviewed).toBe(true);
  expect(requested.data.status).toBe("pending");
  await page.getByRole("button", { name: "Refresh requests" }).click();
  await page
    .locator("[data-deletion-list] button")
    .filter({ hasText: `User ${requested.data.user_id}:` })
    .click();
  const requestForm = page.locator("[data-deletion-form]");
  await requestForm
    .getByLabel("Status", { exact: true })
    .selectOption("in_progress");
  await requestForm
    .getByLabel("Message shown to the requester")
    .fill(
      "Reviewing the identified work records and applicable retention rules.",
    );
  await requestForm
    .getByRole("button", { name: "Save request update" })
    .click();
  await expect(page.locator("[data-deletion-result]")).toContainText(
    "Request updated",
  );
  const updated = await page.evaluate(async () =>
    (await fetch("/api/v1/profile/deletion-request")).json(),
  );
  expect(updated.data.status).toBe("in_progress");
  expect(updated.data.completed_at).toBeNull();
  expect(updated.data.policy_snapshot).toEqual(requested.data.policy_snapshot);
  await page
    .getByRole("button", { name: "Review account closure", exact: true })
    .click();
  await expect(page.locator("[data-closure-inventory]")).toContainText(
    "transfer ownership",
  );
  await expect(page.locator("[data-closure-form]")).toBeHidden();
  const seeded = await page.request.post(
    "/__ezacto_browser_fixture__/start-end",
    {
      data: { action: "account-closure-seed" },
      headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
    },
  );
  expect(seeded.status()).toBe(204);
  await page.getByRole("button", { name: "Refresh requests" }).click();
  await page
    .locator("[data-deletion-list] button")
    .filter({ hasText: "User 97201:" })
    .click();
  await page
    .getByRole("button", { name: "Review account closure", exact: true })
    .click();
  await expect(page.locator("[data-closure-form]")).toBeVisible();
  await page.locator("[data-closure-form]").getByRole("checkbox").check();
  const closed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/closure"),
  );
  await page
    .getByRole("button", {
      name: "Close access and erase local credentials",
      exact: true,
    })
    .click();
  expect((await closed).status()).toBe(200);
  await expect(
    page
      .locator("[data-deletion-list] button")
      .filter({ hasText: "User 97201:" }),
  ).toContainText("action required");
  await page
    .locator("[data-deletion-list] button")
    .filter({ hasText: "User 97201:" })
    .click();
  await page
    .getByRole("button", { name: "Review account closure", exact: true })
    .click();
  await expect(page.locator("[data-closure-inventory]")).toContainText(
    "Local credentials were erased",
  );
  await page
    .getByRole("button", {
      name: "Review retained records and cleanup",
      exact: true,
    })
    .click();
  await expect(
    page.locator("[data-retention-content] form[data-area]"),
  ).toHaveCount(9);
  const areas = await page
    .locator("[data-retention-content] form[data-area]")
    .evaluateAll((forms) =>
      forms.map((form) => (form as HTMLFormElement).dataset.area!),
    );
  for (const area of areas) {
    const review = page.locator(
      `[data-retention-content] form[data-area="${area}"]`,
    );
    await review.locator("..").locator("summary").click();
    const retained =
      area === "audit_and_security" || area === "time_and_worker_attribution";
    await review
      .getByRole("combobox", { name:"Decision", exact: true })
      .selectOption(retained ? "retain" : "not_applicable");
    await review
      .getByLabel("Actual evidence or protected reference")
      .fill(
        "Disposable browser fixture: inspected applicable records and documented their outcome.",
      );
    if (retained) {
      await review
        .getByLabel("Current documented basis")
        .fill(
          "Fixture work and minimal request evidence remain necessary for the documented review.",
        );
      await review
        .getByLabel("Period or release condition")
        .fill(
          "Release after the protected fixture review confirms the purpose ended.",
        );
      await review.getByLabel("Next review date").fill("2099-01-01");
    }
    await review.getByRole("checkbox").check();
    await review
      .getByRole("button", { name: "Record review", exact: true })
      .click();
    await expect(page.locator("[data-retention-review] [data-retention-status]")).toContainText(
      "Review recorded",
    );
    await expect(
      page
        .locator(`[data-retention-content] form[data-area="${area}"]`)
        .locator("input[type=checkbox]"),
    ).not.toBeChecked();
  }
  const complete = page.locator("[data-retention-content] > form");
  await complete
    .getByLabel("I verified each cleanup outcome", { exact: false })
    .check();
  await complete
    .getByRole("button", {
      name: "Confirm reviewed request outcome",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator("[data-deletion-list] button")
      .filter({ hasText: "User 97201:" }),
  ).toContainText("completed");
  await page
    .locator("[data-deletion-list] button")
    .filter({ hasText: "User 97201:" })
    .click();
  await page
    .getByRole("button", {
      name: "Review retained records and cleanup",
      exact: true,
    })
    .click();
  await expect(page.locator("[data-retention-content]")).toContainText(
    "2099-01-01",
  );
  await expect(
    page.getByRole("button", {
      name: "Confirm reviewed request outcome",
      exact: true,
    }),
  ).toHaveCount(0);
  const asserted = await page.request.post(
    "/__ezacto_browser_fixture__/start-end",
    {
      data: { action: "account-closure-assert" },
      headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
    },
  );
  expect(asserted.status()).toBe(204);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
