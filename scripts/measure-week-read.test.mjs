import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROFILES,
  SCENARIOS,
  runScenario,
  measure,
  parseArgs,
  percentile,
  weekRange,
} from "./measure-week-read.mjs";

// A fake instance: pages are served by cursor so paging is real.
const instance = ({ projectPages = 2, entryPages = 2 } = {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, "Bearer tok");
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    const json = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith("/time-entry-settings"))
      return json({ data: { week_start_day: "sunday" } });
    if (u.pathname.endsWith("/projects")) {
      const page = Number(u.searchParams.get("cursor") ?? 1);
      return json({
        data: [{ id: page }],
        page: { next_cursor: page < projectPages ? String(page + 1) : null },
      });
    }
    if (u.pathname.endsWith("/time-entries") && u.searchParams.has("from")) {
      assert.equal(
        new Date(u.searchParams.get("from") + "T12:00:00").getDay(),
        0,
      );
      const page = Number(u.searchParams.get("cursor") ?? 1);
      return json({
        data:
          page === 1
            ? Array.from({ length: 200 }, (_, i) => ({ id: i }))
            : [{ id: 201 }],
        page: { next_cursor: page < entryPages ? String(page + 1) : null },
      });
    }
    return json({ data: [{ id: 1 }, { id: 2 }], page: { next_cursor: null } });
  };
  return { fetchImpl, seen };
};

test("weekRange honours the instance week start", () => {
  const wednesday = new Date(2026, 9, 14);
  assert.deepEqual(weekRange(wednesday, "monday"), {
    from: "2026-10-12",
    to: "2026-10-18",
  });
  assert.deepEqual(weekRange(wednesday, "sunday"), {
    from: "2026-10-11",
    to: "2026-10-17",
  });
  assert.deepEqual(weekRange(wednesday, "saturday"), {
    from: "2026-10-10",
    to: "2026-10-16",
  });
});

test("percentile uses nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
});

test("mobile measures settings plus every page; chrome counts every request", async () => {
  const { fetchImpl, seen } = instance();
  const { weekStart, results } = await measure({
    baseUrl: "https://x.test/",
    token: "tok",
    fetchImpl,
    runs: 2,
  });
  assert.equal(weekStart, "sunday");
  const by = (scenario, mode) =>
    results.find((r) => r.scenario === scenario && r.mode === mode);
  assert.equal(by("mobile-week", "as-the-app-does").requests, 3);
  // running, options, projects x2, tasks, settings, week x2, last4weeks x2
  assert.equal(by("chrome-popup", "as-the-app-does").requests, 10);
  assert.equal(by("chrome-popup", "sequential").requests, 10);
  assert.equal(
    by("chrome-popup", "as-the-app-does").bytes,
    by("chrome-popup", "sequential").bytes,
  );
  assert.ok(by("chrome-popup", "as-the-app-does").bytes > 0);
  assert.ok(seen.every((p) => p.startsWith("/api/v1/")));
  assert.equal(
    seen.length,
    results.reduce((sum, r) => sum + r.requests * r.runs, 0),
    "every request belongs to a reported sample",
  );
  assert.ok(
    seen.some((p) => p.includes("/projects") && p.includes("cursor=2")),
  );
});

test("the simulated profile adds round-trip time, so sequential costs more than parallel", async () => {
  const { fetchImpl } = instance();
  const profile = { rttMs: 20, kbps: Infinity };
  const { results } = await measure({
    baseUrl: "https://x.test",
    token: "tok",
    fetchImpl,
    profile,
    runs: 3,
  });
  const chrome = (mode) =>
    results.find((r) => r.scenario === "chrome-popup" && r.mode === mode);
  assert.ok(chrome("sequential").p50Ms > chrome("as-the-app-does").p50Ms);
  assert.ok(
    chrome("as-the-app-does").p50Ms >= 40,
    "two dependent phases, one round trip each",
  );
  assert.ok(PROFILES["3g"].rttMs > PROFILES["4g"].rttMs);
});

test("a failing request fails the measurement instead of reporting a partial number", async () => {
  const fetchImpl = async (url) =>
    new Response(
      JSON.stringify(
        url.includes("/time-entry-settings")
          ? { data: { week_start_day: "sunday" } }
          : { data: [], page: { next_cursor: null } },
      ),
      { status: url.includes("/projects") ? 401 : 200 },
    );
  await assert.rejects(
    measure({ baseUrl: "https://x.test", token: "tok", fetchImpl, runs: 1 }),
    /\/api\/v1\/projects answered 401/,
  );
});

test("arguments: base url and token are required, token only from the environment", () => {
  assert.throws(() => parseArgs([], { EZACTO_TOKEN: "t" }), /--base-url/);
  assert.throws(
    () => parseArgs(["--base-url", "https://x"], {}),
    /EZACTO_TOKEN/,
  );
  assert.throws(
    () =>
      parseArgs(["--token", "t", "--base-url", "https://x"], {
        EZACTO_TOKEN: "t",
      }),
    /Unknown/,
  );
  assert.throws(
    () =>
      parseArgs(["--base-url", "https://x", "--profile", "5g"], {
        EZACTO_TOKEN: "t",
      }),
    /profile/,
  );
  const ok = parseArgs(
    ["--base-url", "https://x", "--runs", "5", "--profile", "3g", "--json"],
    { EZACTO_TOKEN: "t" },
  );
  assert.deepEqual(
    [ok.runs, ok.profile, ok.json, ok.token],
    [5, "3g", true, "t"],
  );
});

test("mobile includes settings latency/bytes in each sample before any entry request", async () => {
  const { fetchImpl, seen } = instance({ entryPages: 1 });
  const ctx = {
    baseUrl: "https://x.test",
    token: "tok",
    fetchImpl,
    profile: { rttMs: 10, kbps: Infinity },
  };
  const result = await runScenario(ctx, SCENARIOS["mobile-week"]);
  assert.equal(result.count, 2);
  assert.equal(result.requests[0].step, "time-entry-settings");
  assert.equal(result.requests[1].step, "time-entries (week)");
  assert.equal(
    result.bytes,
    result.requests.reduce((sum, r) => sum + r.bytes, 0),
  );
  assert.ok(
    result.ms >= result.requests.reduce((sum, r) => sum + r.ms, 0),
    "both dependent response delays belong to the sample",
  );
  assert.equal(seen.length, 2);
});

test("invalid settings stop before any week request", async () => {
  let calls = 0;
  await assert.rejects(
    measure({
      baseUrl: "https://x.test",
      token: "tok",
      runs: 1,
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({ data: { week_start_day: "tuesday" } }),
        );
      },
    }),
    /week start/,
  );
  assert.equal(calls, 1);
});

test("repeated cursors fail rather than producing a partial measurement or looping", async () => {
  let calls = 0;
  await assert.rejects(
    runScenario(
      {
        baseUrl: "https://x.test",
        token: "tok",
        profile: PROFILES.none,
        fetchImpl: async (url) => {
          calls++;
          return new Response(
            JSON.stringify(
              url.includes("/time-entry-settings")
                ? { data: { week_start_day: "sunday" } }
                : { data: [{ id: 1 }], page: { next_cursor: "same" } },
            ),
          );
        },
      },
      SCENARIOS["mobile-week"],
    ),
    /cursor/,
  );
  assert.equal(calls, 3);
});

test("a later week page error fails the complete measurement", async () => {
  const { fetchImpl } = instance();
  await assert.rejects(
    measure({
      baseUrl: "https://x.test",
      token: "tok",
      runs: 1,
      fetchImpl: async (url, init) =>
        url.includes("cursor=2") && url.includes("/time-entries")
          ? new Response("{}", { status: 503 })
          : fetchImpl(url, init),
    }),
    /time-entries answered 503/,
  );
});

test("a setting change between samples fails instead of averaging different boundaries", async () => {
  let settings = 0;
  await assert.rejects(
    measure({
      baseUrl: "https://x.test",
      token: "tok",
      runs: 2,
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify(
            url.includes("/time-entry-settings")
              ? {
                  data: {
                    week_start_day: ++settings === 1 ? "sunday" : "monday",
                  },
                }
              : { data: [], page: { next_cursor: null } },
          ),
        ),
    }),
    /week start changed/,
  );
});
