import { expect, test } from "@playwright/test";
const control = { "x-ezacto-browser-fixture-control": "start-end-round-trip" };
test("stages selected approved hours once through the real Worker and leaves payment completion in Deel", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.EZACTO_BROWSER_DEEL_STAGING_FIXTURE !== "1",
    "Owned Deel HTTP fixture only",
  );
  expect(
    (
      await request.post("/__ezacto_browser_fixture__/start-end", {
        headers: control,
        data: { action: "deel-stage-seed" },
      })
    ).status(),
  ).toBe(204);
  await page.goto("/payments");
  await page
    .locator("[data-sign-in-form]").getByLabel("Email", { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  await page.locator("[data-payment-month]").fill("2026-08");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Stage approved hours in Deel: Deel 50001 Fixture",
      exact: true,
    })
    .click();
  const section = page.locator("[data-deel-stage]");
  await expect(
    section.getByRole("checkbox", { name: "Deel 50001 Fixture", exact: true }),
  ).toBeChecked();
  await expect(
    section.getByRole("checkbox", { name: "Deel 50002 Fixture", exact: true }),
  ).not.toBeChecked();
  await section
    .getByRole("button", { name: "Review hours for Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-preview]")).toContainText(
    "3600 seconds",
  );
  await section
    .getByRole("checkbox", {
      name: "I reviewed these people, dates, contracts and hours",
    })
    .check();
  await section
    .getByRole("button", { name: "Stage hours in Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-message]")).toContainText(
    "Nothing is marked paid",
  );
  await expect(
    section.getByRole("link", { name: "Complete invoice and payment in Deel" }),
  ).toHaveAttribute("href", "https://app.deel.com/");
  await page
    .getByRole("button", { name: "Stage hours in Deel", exact: true })
    .first()
    .click();
  await section
    .getByRole("checkbox", { name: "Deel 50001 Fixture", exact: true })
    .check();
  await section
    .getByRole("checkbox", { name: "Deel 50002 Fixture", exact: true })
    .check();
  await section
    .getByRole("button", { name: "Review hours for Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-preview]")).toContainText(
    "1 already staged",
  );
  await section
    .getByRole("checkbox", {
      name: "I reviewed these people, dates, contracts and hours",
    })
    .check();
  await section
    .getByRole("button", { name: "Stage hours in Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-message]")).toContainText(
    "Nothing is marked paid",
  );
  await section
    .getByRole("button", { name: "Review hours for Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-preview]")).toContainText(
    "2 already staged",
  );
  await expect(
    section.getByRole("button", { name: "Stage hours in Deel", exact: true }),
  ).toBeDisabled();
  await expect(
    section.getByRole("link", { name: "Complete invoice and payment in Deel" }),
  ).toBeVisible();
  const receipt = await (
    await request.post("/__ezacto_browser_fixture__/start-end", {
      headers: control,
      data: { action: "deel-stage-receipt" },
    })
  ).json();
  expect(receipt.posts).toHaveLength(2);
  expect(receipt.entries).toEqual([{ entry_id: 50001 }, { entry_id: 50002 }]);
  expect(receipt.payments).toBe(0);
  for (const post of receipt.posts) {
    expect(post.data.quantity).toBe(1);
    expect(post.data).not.toHaveProperty("amount");
    expect(post.data).not.toHaveProperty("rate");
  }
  for (const node of await section.locator("button,input").all()) {
    if (!(await node.isVisible())) continue;
    const box = await node.boundingBox();
    if ((await node.getAttribute("type")) === "checkbox") continue;
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath("deel-staging-phone.png"),
    fullPage: true,
  });
});
