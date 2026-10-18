// Week-read measurement (issue 599, slice A). Replays what the mobile app's
// Week screen and the Chrome popup send to an instance when they open, and
// reports request count, payload bytes and wall time for each. It exists to put
// a number on "does the week need a composed endpoint" before anyone builds one.
//
//   EZACTO_TOKEN=ezacto_... node scripts/measure-week-read.mjs \
//     --base-url https://dev.example --runs 20 --profile 3g [--json]
//
// The token is read from the environment only, never an argument. It needs the
// time_entries:read and projects:read scopes. It makes GET requests only.
//
// Network shaping is simulated in the client: each response is held for
// `rttMs` and then for payload-size / bandwidth. That approximates a slow link
// for comparing shapes (parallel against sequential, one call against several);
// it is not a device measurement, and the written result must say which it was.
import { pathToFileURL } from "node:url";

export const PROFILES = {
  none: { rttMs: 0, kbps: Infinity },
  "4g": { rttMs: 100, kbps: 9000 },
  "3g": { rttMs: 300, kbps: 1600 },
  slow3g: { rttMs: 400, kbps: 400 },
};

const PER_PAGE = 200;
const DAY = 864e5;
const START_INDEX = { sunday: 0, monday: 1, saturday: 6 };

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** First and last day of the week containing `date`, as Chrome's popup computes them. */
export const weekRange = (date, weekStart = "monday") => {
  const back = (date.getDay() - START_INDEX[weekStart] + 7) % 7;
  const first = new Date(date);
  first.setDate(date.getDate() - back);
  const last = new Date(first);
  last.setDate(first.getDate() + 6);
  return { from: iso(first), to: iso(last) };
};

const query = (params) =>
  "?" +
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

/**
 * A scenario is phases run one after another; the steps inside a phase run
 * together, as the app's Promise.all does. A step with `paged` follows
 * page.next_cursor until it ends, the way the Chrome client does. Mobile's
 * entriesInRange reads one page only, so its step is not paged.
 */
export const SCENARIOS = {
  "mobile-week": {
    describes:
      "mobile Week screen focus: loadWeek -> entriesInRange (src/api/time.ts)",
    phases: () => {
      const { from, to } = weekRange(new Date(), "monday");
      return [
        [
          {
            name: "time-entries (week)",
            path: "/api/v1/time-entries",
            params: { from, to, per_page: PER_PAGE },
          },
        ],
      ];
    },
  },
  "chrome-popup": {
    describes:
      "Chrome popup open: renderStatus in src/popup/popup.ts, without the active-tab lookup",
    phases: (ctx) => {
      const { from, to } = weekRange(new Date(), ctx.weekStart);
      const earlier = weekRange(
        new Date(Date.now() - 21 * DAY),
        ctx.weekStart,
      ).from;
      return [
        [
          {
            name: "time-entries (running)",
            path: "/api/v1/time-entries",
            params: { is_running: true, per_page: 1 },
          },
          { name: "time-entry-options", path: "/api/v1/time-entry-options" },
          {
            name: "projects",
            path: "/api/v1/projects",
            params: { is_active: true, per_page: PER_PAGE },
            paged: true,
          },
          {
            name: "tasks",
            path: "/api/v1/tasks",
            params: { is_active: true, per_page: PER_PAGE },
            paged: true,
          },
          { name: "time-entry-settings", path: "/api/v1/time-entry-settings" },
        ],
        [
          {
            name: "time-entries (week)",
            path: "/api/v1/time-entries",
            params: { from, to, per_page: PER_PAGE },
            paged: true,
          },
          {
            name: "time-entries (last 4 weeks)",
            path: "/api/v1/time-entries",
            params: { from: earlier, to, per_page: PER_PAGE },
            paged: true,
          },
        ],
      ];
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET, shaped by the profile. Returns the parsed body and what it cost. */
export const timedGet = async ({ baseUrl, token, fetchImpl, profile }, url) => {
  const started = performance.now();
  const response = await fetchImpl(baseUrl + url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (!response.ok)
    throw new Error(`GET ${url.split("?")[0]} answered ${response.status}`);
  const held = profile.rttMs + (bytes * 8) / profile.kbps;
  if (held > 0) await sleep(held);
  return {
    body: JSON.parse(text),
    request: { url, bytes, ms: performance.now() - started },
  };
};

const runStep = async (ctx, step) => {
  const requests = [];
  let cursor;
  do {
    const params = { ...(step.params ?? {}), ...(cursor ? { cursor } : {}) };
    const { body, request } = await timedGet(
      ctx,
      step.path + (step.params || cursor ? query(params) : ""),
    );
    requests.push({ step: step.name, ...request });
    cursor = step.paged ? (body?.page?.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return requests;
};

/**
 * Run one scenario once. `sequential` flattens every phase into one line, which
 * is the worst case a slower runtime or a constrained connection pool produces.
 */
export const runScenario = async (
  ctx,
  scenario,
  { sequential = false } = {},
) => {
  const phases = scenario.phases(ctx);
  const started = performance.now();
  const requests = [];
  for (const phase of phases) {
    if (sequential)
      for (const step of phase) requests.push(...(await runStep(ctx, step)));
    else
      requests.push(
        ...(await Promise.all(phase.map((s) => runStep(ctx, s)))).flat(),
      );
  }
  return {
    ms: performance.now() - started,
    count: requests.length,
    bytes: requests.reduce((n, r) => n + r.bytes, 0),
    requests,
  };
};

/** Nearest-rank percentile; the inputs are small run counts. */
export const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Measure every scenario in both modes, `runs` times each. */
export const measure = async ({
  baseUrl,
  token,
  fetchImpl = fetch,
  profile = PROFILES.none,
  runs = 10,
}) => {
  const ctx = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    fetchImpl,
    profile,
    weekStart: "monday",
  };
  // The popup asks the instance where weeks start; so does this, once, unshaped.
  const settings = await timedGet(
    { ...ctx, profile: PROFILES.none },
    "/api/v1/time-entry-settings",
  );
  const configured = settings.body?.data?.week_start_day;
  if (configured in START_INDEX) ctx.weekStart = configured;

  const results = [];
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const sequential of [false, true]) {
      const samples = [];
      for (let i = 0; i < runs; i += 1)
        samples.push(await runScenario(ctx, scenario, { sequential }));
      const ms = samples.map((s) => s.ms);
      results.push({
        scenario: name,
        describes: scenario.describes,
        mode: sequential ? "sequential" : "as-the-app-does",
        runs,
        requests: samples[0].count,
        bytes: samples[0].bytes,
        p50Ms: Math.round(percentile(ms, 50)),
        p95Ms: Math.round(percentile(ms, 95)),
        calls: samples[0].requests.map(({ step, url, bytes: b }) => ({
          step,
          url: url.split("?")[0],
          bytes: b,
        })),
      });
    }
  }
  return { weekStart: ctx.weekStart, results };
};

export const parseArgs = (argv, env = process.env) => {
  const out = { runs: 10, profile: "none", json: false, baseUrl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--profile") out.profile = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!out.baseUrl) throw new Error("--base-url is required");
  if (!Number.isInteger(out.runs) || out.runs < 1)
    throw new Error("--runs must be a positive integer");
  if (!(out.profile in PROFILES))
    throw new Error(
      `--profile must be one of ${Object.keys(PROFILES).join(", ")}`,
    );
  if (!env.EZACTO_TOKEN) throw new Error("EZACTO_TOKEN is not set");
  out.token = env.EZACTO_TOKEN;
  return out;
};

export const formatTable = ({ weekStart, results }, profileName) => {
  const lines = [
    `week start ${weekStart}, profile ${profileName} (simulated in the client)`,
  ];
  for (const r of results)
    lines.push(
      `${r.scenario.padEnd(12)} ${r.mode.padEnd(15)} ${String(r.requests).padStart(3)} requests ${String(r.bytes).padStart(8)} B  p50 ${String(r.p50Ms).padStart(6)} ms  p95 ${String(r.p95Ms).padStart(6)} ms  (${r.runs} runs)`,
    );
  return lines.join("\n");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await measure({ ...args, profile: PROFILES[args.profile] });
    console.log(
      args.json
        ? JSON.stringify({ profile: args.profile, ...report }, null, 2)
        : formatTable(report, args.profile),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
