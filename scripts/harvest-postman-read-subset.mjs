import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { URL, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const meta = {
  repository: "https://github.com/kgajera/hrvst-cli",
  commit: "088414c97e182048fd901ba1252fdafbd0e97e65",
  file: "harvest-api-v2-postman-collection.json",
  sha256: "c92b474b437d7af652e03514cf3504cfe11e12bb38fac658b67b3e8be5613f48",
};
const allowed =
  /^\/v2\/(?:(?:clients|projects|tasks|expenses|time_entries)(?:\/:[a-z_]+)?|users(?:\/(?:me|:user_id)(?:\/project_assignments)?)?)$/;
export const checkScripts = (node) => {
  for (const e of node.event ?? [])
    assert.ok(
      (e.script?.exec ?? []).every((x) => typeof x === "string" && !x.trim()),
      "Nonempty collection script forbidden",
    );
  for (const x of node.item ?? []) checkScripts(x);
};
export function requestPlan(item, cfg) {
  assert.equal(item.request.method, "GET", "Only GET permitted");
  const url = new URL(item.request.url.raw);
  assert.equal(url.origin, "https://api.harvestapp.com");
  assert.ok(!url.username && !url.password, "Upstream credentials forbidden");
  assert.ok(allowed.test(url.pathname), "Unsupported path");
  let pathname = url.pathname.replace(/:([a-z_]+)/g, (_, key) => {
    assert.ok(Number.isSafeInteger(cfg.ids[key]) && cfg.ids[key] > 0);
    return String(cfg.ids[key]);
  });
  const destination = new URL(cfg.origin);
  assert.ok(["localhost", "127.0.0.1"].includes(destination.hostname));
  assert.equal(destination.protocol, "http:");
  assert.ok(
    !destination.username && !destination.password,
    "Origin credentials forbidden",
  );
  assert.equal(destination.pathname, "/");
  assert.equal(destination.search, "");
  assert.equal(destination.hash, "");
  destination.pathname = "/harvest" + pathname;
  destination.search = url.search;
  const env = { HARVEST_ACCOUNT_ID: "1", ACCESS_TOKEN: "Bearer " + cfg.token };
  const headers = {};
  for (const h of item.request.header ?? []) {
    if (h.disabled) continue;
    assert.ok(
      [
        "authorization",
        "harvest-account-id",
        "user-agent",
        "content-type",
      ].includes(h.key.toLowerCase()),
    );
    const value = h.value.replace(/{{([^}]+)}}/g, (_, key) => {
      assert.ok(Object.hasOwn(env, key));
      return env[key];
    });
    assert.ok(!value.includes("{{"));
    headers[h.key] = value;
  }
  return {
    destination,
    headers,
    sourcePath: url.pathname + url.search,
    resolvedPath: pathname + url.search,
  };
}
export async function runCollection(collection, cfg, request = fetch) {
  checkScripts(collection);
  assert.match(cfg.expectedSourceRevision, /^[a-f0-9]{40}$/);
  const probeOrigin = new URL(cfg.origin);
  assert.ok(["localhost", "127.0.0.1"].includes(probeOrigin.hostname));
  assert.equal(probeOrigin.protocol, "http:");
  assert.ok(!probeOrigin.username && !probeOrigin.password);
  assert.equal(probeOrigin.pathname, "/");
  assert.ok(!probeOrigin.search && !probeOrigin.hash);
  const items = [];
  function walk(node, path = []) {
    for (const item of node.item ?? []) {
      if (item.item) walk(item, [...path, item.name]);
      else items.push({ path: [...path, item.name], item });
    }
  }
  walk(collection);
  const selected = items.filter(
    ({ item }) =>
      item.request?.method === "GET" &&
      allowed.test(new URL(item.request.url.raw).pathname),
  );
  assert.equal(
    selected.length,
    15,
    "Expected exactly 15 supported GET requests",
  );
  assert.equal(
    new Set(selected.map(({ item }) => item.request.url.raw)).size,
    15,
    "Duplicate selected request",
  );
  const plans = selected.map(({ path, item }) => ({
    path,
    item,
    plan: requestPlan(item, cfg),
  }));
  const health = await request(new URL("/healthz", probeOrigin), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(health.status, 200, "Health probe failed");
  const healthBody = await health.json();
  assert.equal(
    healthBody.release,
    cfg.expectedSourceRevision,
    "Health revision mismatch",
  );
  const results = [];
  for (const { path, item, plan } of plans) {
    const response = await request(plan.destination, {
      method: "GET",
      headers: plan.headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, "Selected request failed");
    const body = await response.json();
    {
      const parts = plan.resolvedPath.split("?")[0].split("/").filter(Boolean);
      if (parts.at(-1) === "project_assignments") {
        assert.equal(body.project_assignments.length, 1);
        assert.equal(body.project_assignments[0].project.id, 1);
      } else if (parts.length === 2) {
        assert.equal(body[parts[1]].length, 1);
        assert.equal(body.total_entries, 1);
        assert.ok(Number.isInteger(body.page));
        assert.ok(body.links);
      } else {
        assert.equal(body.id, 1);
      }
      const rows = parts.length === 2 ? body[parts[1]] : [body];
      if (parts[1] === "time_entries") {
        for (const row of rows) {
          assert.equal(row.hours, 1.25);
          assert.equal(row.project.id, 1);
          assert.equal(row.task.id, 1);
        }
      }
      if (parts[1] === "expenses") {
        for (const row of rows) {
          assert.equal(row.total_cost, 23.45);
          assert.equal(row.project.id, 1);
        }
      }
    }
    results.push({
      request_path: path,
      request_sha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(item.request))
        .digest("hex"),
      original_path: plan.sourcePath,
      resolved_path: plan.resolvedPath,
      status: response.status,
      response_keys: Object.keys(body),
      ...(body.error ? { error_code: body.error.code } : {}),
      ...(Array.isArray(body.clients) ? { rows: body.clients.length } : {}),
      ...(Array.isArray(body.projects) ? { rows: body.projects.length } : {}),
      ...(Array.isArray(body.tasks) ? { rows: body.tasks.length } : {}),
      ...(Array.isArray(body.users) ? { rows: body.users.length } : {}),
      ...(Array.isArray(body.time_entries)
        ? { rows: body.time_entries.length }
        : {}),
      ...(Array.isArray(body.expenses) ? { rows: body.expenses.length } : {}),
      ...(Array.isArray(body.project_assignments)
        ? { rows: body.project_assignments.length }
        : {}),
    });
  }
  const evidence = {
    source_revision_asserted: cfg.expectedSourceRevision,
    health_revision_probed: healthBody.release,
    upstream: meta,
    upstream_license: "MIT",
    collection_unchanged: true,
    runner:
      "Own GET-only adapter reads original request definitions; substitutes fixture path variables/authorization variables, then rewrites exact https://api.harvestapp.com/v2 origin to owned loopback /harvest/v2 transport. No collection bytes modified. No Postman scripts executed; all scripts verified blank. Redirects denied.",
    native_fixture:
      "New pinned container, volume, fictional owner/client/project/task/entry/expense; short-lived native read-only token.",
    scopes: [
      "clients:read",
      "projects:read",
      "team:read",
      "time_entries:read",
      "expenses:read",
    ],
    response_assertions:
      "All selected responses status200; list counts1/pagination envelope; detail IDs1; assignment project1; time1.25hours; expense23.45USD.",
    selected_requests: results.length,
    passed: results.filter((x) => x.status === 200).length,
    results,
    limitations: [
      "Selected supported GET subset only; no writes/invoices or full Postman runtime executed",
      "No Harvest request, credential, production or customer data used",
    ],
  };
  assert.equal(results.length, 15);
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [collectionPath, configPath, outputPath] = process.argv.slice(2);
    if (!collectionPath || !configPath || !outputPath)
      throw new Error("Missing arguments");
    const bytes = fs.readFileSync(collectionPath);
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      meta.sha256,
    );
    const result = await runCollection(
      JSON.parse(bytes),
      JSON.parse(fs.readFileSync(configPath)),
    );
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        selected: result.selected_requests,
        passed: result.passed,
      }),
    );
  } catch {
    console.error(
      "Harvest subset acceptance failed; no credentials or response data are logged.",
    );
    process.exitCode = 1;
  }
}
