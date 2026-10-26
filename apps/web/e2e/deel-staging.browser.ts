import { expect, test } from "@playwright/test";
const control = { "x-ezacto-browser-fixture-control": "start-end-round-trip" };
test("stages administrator-reviewed unsubmitted and approved hours once without changing approvals or recording payments", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.EZACTO_BROWSER_DEEL_STAGING_FIXTURE !== "1",
    "Owned Deel HTTP fixture only",
  );
  await page.clock.install();
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
      name: "Stage hours in Deel: Deel 50001 Fixture",
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
  await expect(
    section.getByRole("button", { name: "Stage hours in Deel", exact: true }),
  ).toBeDisabled();
  const beforeReview = await (
    await request.post("/__ezacto_browser_fixture__/start-end", {
      headers: control,
      data: { action: "deel-stage-receipt" },
    })
  ).json();
  expect(beforeReview.posts).toEqual([]);
  expect(beforeReview.approvals).toEqual([
    { id: 50001, approval_status: "unsubmitted", timesheet_submission_id: null },
    { id: 50002, approval_status: "approved", timesheet_submission_id: 50002 },
  ]);
  expect(beforeReview.submissions).toEqual([
    { id: 50002, status: "approved", version: 1 },
  ]);
  await section
    .getByRole("checkbox", {
      name: "I reviewed these people, dates, contracts and hours",
    })
    .check();
  await section
    .getByRole("button", { name: "Stage hours in Deel", exact: true })
    .click();
  await expect(section.locator("[data-deel-stage-message]")).toContainText(
    "these entries are not marked paid here",
  );
  await expect(page.locator('[data-payment-list] [data-deel-staging-status="50001"]')).toContainText('Staged in Deel');
  await expect(page.locator('[data-payment-list] [data-deel-staging-label="50001"]')).toHaveText('Staged in Deel');
  await expect(page.locator('[data-payment-list] [data-deel-staging-status="50002"]')).toContainText('Not staged');
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
    "these entries are not marked paid here",
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
  expect(receipt.approvals).toEqual(beforeReview.approvals);
  expect(receipt.submissions).toEqual(beforeReview.submissions);
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
  await page.reload();
  await page.locator("[data-payment-month]").fill("2026-08");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  for (const userId of [50001, 50002]) {
    await expect(page.locator(`[data-payment-list] [data-deel-staging-status="${userId}"]`)).toContainText('Staged in Deel');
    await expect(page.locator(`[data-payment-list] [data-deel-staging-status="${userId}"]`)).toContainText('1.00 h staged');
  }
  await request.post('/__ezacto_browser_fixture__/start-end', {
    headers: control, data: { action: 'deel-status-processing', timesheets: [1, 2] },
  });
  await page.clock.fastForward(31_000);
  for (const userId of [50001, 50002]) {
    await expect(page.locator(`[data-payment-list] [data-deel-staging-label="${userId}"]`)).toHaveText('Payment processing in Deel');
  }
  await request.post('/__ezacto_browser_fixture__/start-end', {
    headers: control, data: { action: 'deel-status-paid', timesheets: [1] },
  });
  await page.clock.fastForward(31_000);
  await expect(page.locator('[data-payment-list] [data-deel-staging-label="50001"]')).toHaveText('Paid in Deel');
  await expect(page.locator('[data-payment-list] [data-deel-staging-label="50002"]')).toHaveText('Payment processing in Deel');
  await request.post('/__ezacto_browser_fixture__/start-end', {
    headers: control, data: { action: 'deel-status-paid', timesheets: [2] },
  });
  await page.clock.fastForward(31_000);
  await expect(page.locator('[data-payment-list] [data-deel-staging-label="50002"]')).toHaveText('Paid in Deel');
  await page.screenshot({ path: testInfo.outputPath('deel-paid-phone.png'), fullPage: true });
  const afterPaymentStatus = await (await request.post('/__ezacto_browser_fixture__/start-end', {
    headers: control, data: { action: 'deel-stage-receipt' },
  })).json();
  expect(afterPaymentStatus.posts).toHaveLength(2);
  expect(afterPaymentStatus.payments).toBe(0);
});
