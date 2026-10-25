import { expect, test, type Page } from "@playwright/test";

const request = (page: Page, method: string, path: string, data?: unknown) =>
  page.evaluate(
    async (args) => {
      const response = await fetch(args.path, {
        method: args.method,
        credentials: "same-origin",
        ...(args.data === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args.data),
            }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    },
    { method, path, data },
  );

test("[e2e #1191] phone planning creates, edits, refuses overlap, resolves conflicts and assigns real unassigned work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(process.env.EZACTO_BROWSER_FIXTURE_INSTANT!);
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.goto("/capacity");
  await page.request.post("/__ezacto_browser_fixture__/start-end", {
    data: { action: "sign-in-rate-reset" },
    headers: { "x-ezacto-browser-fixture-control": "start-end-round-trip" },
  });
  await page
    .locator("[data-sign-in-form]")
    .getByLabel("Email")
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!);
  const firstCapacity = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/capacity" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const baseline = (await (await firstCapacity).json()).data;
  const from = baseline.weeks[0] as string;
  const to = new Date(Date.parse(from + "T00:00:00Z") + 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const suffix = crypto.randomUUID();
  let projectId: number | undefined,
    definitionId: number | undefined,
    planId: number | undefined,
    allocationId: number | undefined,
    blockerId: number | undefined;
  const host = page.locator("[data-capacity-placeholders]");
  const planForm = host.locator("[data-placeholder-plan-form]");
  const status = host.locator("[data-placeholder-status]");
  const personWeek = (data: typeof baseline) =>
    data.people.find((person: { user_id: number }) => person.user_id === 1)
      .weeks[0];
  try {
    const project = await request(page, "POST", "/api/v1/projects", {
      client_id: 1,
      name: "Unassigned planning fixture " + suffix,
      billing_method: "time_materials",
      bill_by: "people",
    });
    expect(project.status).toBe(201);
    projectId = project.body.data.id;
    await page.reload();
    await expect(
      host.locator("[data-placeholder-definition-form]"),
    ).toBeVisible();
    await host
      .locator("[data-placeholder-definition-form]")
      .getByLabel("Placeholder name")
      .fill("Unfilled designer " + suffix);
    const createDefinition = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/planning-placeholders" &&
        response.request().method() === "POST",
    );
    await host
      .getByRole("button", { name: "Add placeholder", exact: true })
      .click();
    const definition = await createDefinition;
    expect(definition.status()).toBe(201);
    definitionId = (await definition.json()).data.id;
    const definitions = await request(
      page,
      "GET",
      "/api/v1/planning-placeholders?is_active=true&per_page=200",
    );
    expect(definitions.status).toBe(200);
    expect(
      definitions.body.data.map((value: { id: number }) => value.id),
    ).toContain(definitionId);
    await expect
      .poll(() =>
        planForm
          .getByRole("combobox", { name: "Placeholder", exact: true })
          .locator("option")
          .evaluateAll((elements) =>
            elements.map((element) => (element as HTMLOptionElement).value),
          ),
      )
      .toContain(String(definitionId));
    await expect(
      planForm
        .getByRole("combobox", { name: "Placeholder", exact: true })
        .locator(`option[value="${definitionId}"]`),
    ).toBeAttached();
    await planForm
      .getByRole("combobox", { name: "Placeholder", exact: true })
      .selectOption(String(definitionId));
    await planForm
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(String(projectId));
    await planForm.getByLabel("From", { exact: true }).fill(from);
    await planForm.getByLabel("To", { exact: true }).fill(to);
    await planForm.getByLabel("Hours per week", { exact: true }).fill("5");
    const createPlan = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/v1/placeholder-allocations" &&
        response.request().method() === "POST",
    );
    await planForm
      .getByRole("button", { name: "Add unassigned work", exact: true })
      .click();
    const created = await createPlan;
    expect(created.status()).toBe(201);
    planId = (await created.json()).data.id;
    const planRow = host.locator(
      `[data-placeholder-rows] tr[data-row-key="${planId}"]`,
    );
    await expect(planRow).toContainText("5h");
    const unchanged = await request(
      page,
      "GET",
      `/api/v1/capacity?from=${from}&to=${to}`,
    );
    expect(personWeek(unchanged.body.data).planned_seconds).toBe(
      personWeek(baseline).planned_seconds,
    );
    expect(personWeek(unchanged.body.data).tracked_seconds).toBe(
      personWeek(baseline).tracked_seconds,
    );
    await planRow
      .getByRole("button", { name: "Edit unassigned work", exact: true })
      .click();
    await planForm.getByLabel("Hours per week", { exact: true }).fill("7");
    const edit = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/placeholder-allocations/${planId}` &&
        response.request().method() === "PATCH",
    );
    await planForm
      .getByRole("button", { name: "Save unassigned work", exact: true })
      .click();
    expect((await edit).status()).toBe(200);
    await expect(planRow).toContainText("7h");
    await planRow
      .getByRole("button", { name: "Edit unassigned work", exact: true })
      .click();
    const concurrent = await request(
      page,
      "PATCH",
      `/api/v1/placeholder-allocations/${planId}`,
      {
        version: 1,
        start_date: from,
        end_date: to,
        planned_seconds_per_week: 9 * 3600,
      },
    );
    expect(concurrent.status).toBe(200);
    await planForm.getByLabel("Hours per week", { exact: true }).fill("4");
    const stale = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/placeholder-allocations/${planId}` &&
        response.request().method() === "PATCH",
    );
    await planForm
      .getByRole("button", { name: "Save unassigned work", exact: true })
      .click();
    expect((await stale).status()).toBe(409);
    await expect(status).toContainText("Your inputs are kept");
    await expect(
      planForm.getByLabel("Hours per week", { exact: true }),
    ).toHaveValue("4");
    await host
      .getByRole("button", { name: "Reload saved planning", exact: true })
      .click();
    await expect(status).toHaveText("");
    await expect(planRow).toContainText("9h");
    await page.screenshot({
      path: test.info().outputPath("unassigned-planning-phone.png"),
      fullPage: true,
    });
    const blocker = await request(page, "POST", "/api/v1/allocations", {
      user_id: 1,
      project_id: projectId,
      start_date: from,
      end_date: to,
      planned_seconds_per_week: 3600,
    });
    expect(blocker.status).toBe(201);
    blockerId = blocker.body.data.id;
    await planRow.getByLabel("More actions").focus();
    await planRow.getByLabel("More actions").press("Enter");
    await planRow
      .getByRole("button", { name: "Assign to person", exact: true })
      .click();
    const assignForm = host.locator("[data-placeholder-assign-form]");
    await assignForm
      .getByRole("combobox", { name: "Person", exact: true })
      .selectOption("1");
    const overlap = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/v1/placeholder-allocations/${planId}/assign`,
    );
    await assignForm
      .getByRole("button", { name: "Assign to person", exact: true })
      .click();
    expect((await overlap).status()).toBe(409);
    await expect(planRow).toContainText("9h");
    await expect(
      assignForm.getByRole("combobox", { name: "Person", exact: true }),
    ).toHaveValue("1");
    expect(
      (
        await request(page, "DELETE", `/api/v1/allocations/${blockerId}`, {
          version: 0,
        })
      ).status,
    ).toBe(200);
    blockerId = undefined;
    await host
      .getByRole("button", { name: "Reload saved planning", exact: true })
      .click();
    await expect(status).toHaveText("");
    await planRow.getByLabel("More actions").click();
    await planRow
      .getByRole("button", { name: "Assign to person", exact: true })
      .click();
    await assignForm
      .getByRole("combobox", { name: "Person", exact: true })
      .selectOption("1");
    const assigned = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/v1/placeholder-allocations/${planId}/assign`,
    );
    await assignForm
      .getByRole("button", { name: "Assign to person", exact: true })
      .click();
    const result = await assigned;
    expect(result.status()).toBe(200);
    const assignment = (await result.json()).data;
    allocationId = assignment.allocation.id;
    expect(assignment.placeholder.state).toBe("assigned");
    await expect(planRow).toHaveCount(0);
    const replay = await request(
      page,
      "POST",
      `/api/v1/placeholder-allocations/${planId}/assign`,
      result.request().postDataJSON(),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(assignment);
    expect(replay.body.data.allocation.id).toBe(allocationId);
    const final = await request(
      page,
      "GET",
      `/api/v1/capacity?from=${from}&to=${to}`,
    );
    expect(personWeek(final.body.data).planned_seconds).toBe(
      personWeek(baseline).planned_seconds + 9 * 3600,
    );
    expect(personWeek(final.body.data).tracked_seconds).toBe(
      personWeek(baseline).tracked_seconds,
    );
    const controls = await host
      .locator("input:visible,select:visible,button:visible,summary:visible")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
      );
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((height) => height >= 44)).toBe(true);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
  } finally {
    for (const id of [blockerId, allocationId]) {
      if (id !== undefined) {
        const current = await request(page, "GET", `/api/v1/allocations/${id}`);
        if (current.status === 200)
          await request(page, "DELETE", `/api/v1/allocations/${id}`, {
            version: current.body.data.version,
          });
      }
    }
    if (definitionId !== undefined) {
      const current = await request(
        page,
        "GET",
        "/api/v1/planning-placeholders?per_page=200",
      );
      const definition = current.body?.data?.find(
        (value: { id: number }) => value.id === definitionId,
      );
      if (definition)
        await request(
          page,
          "DELETE",
          `/api/v1/planning-placeholders/${definitionId}`,
          { version: definition.version },
        );
    }
    if (projectId !== undefined)
      await request(page, "DELETE", `/api/v1/projects/${projectId}`);
  }
});
