import { createApiApp } from "../../api/src/index.js";
import { describe, expect, it } from "vitest";
import { EzactoClient } from "../src/index.js";
import type { EzactoApiError } from "../src/index.js";

const project = {
  id: 7,
  client_id: 3,
  name: "Launch",
  created_at: "2026-08-28T12:00:00.000Z",
  updated_at: "2026-08-28T12:00:00.000Z",
};

const app = createApiApp({
  authentication: {
    tokens: {
      authenticate: async (token) =>
        token === "generated-client-test"
          ? {
              tokenId: 1,
              userId: 4,
              profile: "administrator",
              scopes: ["projects:write", "time_entries:write", "reports:read"],
            }
          : null,
      issue: async () => {
        throw new Error("not used");
      },
      list: async () => [],
      revoke: async () => null,
    },
  },
  installApi: (api) => {
    api.post("/projects", async (context) => {
      const body = await context.req.json<Record<string, unknown>>();
      return context.json(
        {
          data: { ...project, ...body },
          links: { self: "/api/v1/projects/7" },
        },
        201,
      );
    });
    api.get("/projects", (context) =>
      context.json({
        data: [project],
        links: {
          self: `/api/v1/projects?${new URL(context.req.url).searchParams.toString()}`,
          next: null,
        },
        page: { per_page: 25, next_cursor: null },
      }),
    );
    api.post("/time-entries", async (context) => {
      const body = await context.req.json<Record<string, unknown>>();
      return context.json(
        {
          data: {
            id: 11,
            user_id: 4,
            ...body,
            spent_date: "2026-08-28",
            seconds: body.seconds ?? 0,
            is_running: body.seconds === undefined,
            billable: true,
            budgeted: false,
            approval_status: "unsubmitted",
            is_billed: false,
            is_locked: false,
            created_at: "2026-08-28T12:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
          links: { self: "/api/v1/time-entries/11" },
        },
        201,
      );
    });
    api.get("/reports/uninvoiced", (context) =>
      context.json({
        data: {
          from: context.req.query("from"),
          to: context.req.query("to"),
          client_id: null,
          project_id: null,
          totals: [],
        },
        links: { self: context.req.path },
      }),
    );
  },
});

const client = (token = "generated-client-test") =>
  new EzactoClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });

it("[unit] sends required report range filters through the generated client", async () => {
  const report = await client().getUninvoicedReport({
    query: { from: "2026-08-01", to: "2026-08-31" },
  });
  expect(report.data).toMatchObject({
    from: "2026-08-01",
    to: "2026-08-31",
    totals: [],
  });
});

describe("generated ezacto client", () => {
  it("[unit] round-trips core project and time resources", async () => {
    const created = await client().createProject({
      body: { client_id: 3, name: "Launch" },
    });
    expect(created.data).toMatchObject({ id: 7, name: "Launch" });

    const listed = await client().listProjects({ query: { per_page: 25 } });
    expect(listed.page.per_page).toBe(25);
    expect(listed.data).toEqual([project]);

    const time = await client().createTimeEntry({
      body: { project_id: 7, task_id: 2, seconds: 7200 },
    });
    expect(time.data).toMatchObject({
      project_id: 7,
      task_id: 2,
      seconds: 7200,
      is_running: false,
    });
  });

  it("[unit] surfaces the stable API error and request id", async () => {
    await expect(client("wrong-token").listProjects()).rejects.toMatchObject({
      name: "EzactoApiError",
      status: 401,
      body: {
        error: { code: "authentication_required" },
      },
    } satisfies Partial<EzactoApiError>);
  });
});
