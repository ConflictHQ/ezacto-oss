import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  REVIEW,
  reviewSecrets,
  resolveDatabase,
  renderEnvironment,
  assertReviewConfig,
  requireVerifiedR2,
  verifyDatabaseBinding,
} from "./app-review-instance.mjs";
import { parseJsonc } from "./provision-cloudflare-queues.mjs";
import { bootstrapReview } from "./bootstrap-app-review.mjs";

const id = "b99391a1-1328-4ae0-a45b-01eecf07a867";
const env = {
  REVIEW_CURSOR_SIGNING_KEY: Buffer.alloc(32, 5).toString("base64url"),
  REVIEW_BOOTSTRAP_TOKEN: `ezacto_${"A".repeat(16)}_${"B".repeat(43)}`,
  REVIEW_OWNER_PASSWORD: "private-test-password-24-characters",
};

test("secrets only use review keys, ignoring inherited production integrations", () => {
  const payload = reviewSecrets({
    ...env,
    API_CURSOR_SIGNING_KEY: "wrong",
    AWS_ACCESS_KEY_ID: "prod",
    STRIPE_API_KEY: "prod",
    APPLE_CLIENT_ID: "unrelated.app",
    APPLE_WEB_ENABLED: "true",
    APPLE_WEB_SERVICES_ID: "unrelated.web",
    APPLE_SIGN_IN_PRIVATE_KEY: "must-not-inherit",
    OIDC_GOOGLE_CLIENT_SECRET: "prod",
    SENTRY_DSN: "prod",
  });
  assert.equal(payload.API_CURSOR_SIGNING_KEY, env.REVIEW_CURSOR_SIGNING_KEY);
  assert.equal(payload.EZACTO_BOOTSTRAP_TOKEN, env.REVIEW_BOOTSTRAP_TOKEN);
  assert.equal(payload.APPLE_CLIENT_ID, "com.ezacto.app");
  assert.equal(reviewSecrets(env).APPLE_CLIENT_ID, "com.ezacto.app");
  assert.equal("APPLE_SIGN_IN_PRIVATE_KEY" in payload, false);
  for (const [key, value] of Object.entries(payload)) {
    if (
      ![
        "API_CURSOR_SIGNING_KEY",
        "EZACTO_BOOTSTRAP_TOKEN",
        "APPLE_CLIENT_ID",
      ].includes(key)
    )
      assert.equal(value, null, key);
  }
  for (const key of Object.keys(env))
    assert.throws(() => reviewSecrets({ ...env, [key]: "" }));
});

test("database resolution uses one exact name and never picks production or a prefix", async () => {
  const calls = [];
  const result = await resolveDatabase((args) => {
    calls.push(args);
    return JSON.stringify([
      { name: "ezacto-app-review-old", uuid: "wrong" },
      { name: REVIEW.database, uuid: id },
    ]);
  });
  assert.equal(result, id);
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
});

test("missing database is created once then rediscovered; duplicates and invalid UUID fail closed", async () => {
  const calls = [];
  assert.equal(
    await resolveDatabase((args) => {
      calls.push(args);
      return JSON.stringify(
        calls.length === 3 ? [{ name: REVIEW.database, uuid: id }] : [],
      );
    }),
    id,
  );
  assert.deepEqual(calls, [
    ["d1", "list", "--json"],
    ["d1", "create", REVIEW.database],
    ["d1", "list", "--json"],
  ]);
  for (const rows of [
    [],
    [{ name: REVIEW.database, uuid: "bad" }],
    [
      { name: REVIEW.database, uuid: id },
      { name: REVIEW.database, uuid: id },
    ],
  ]) {
    await assert.rejects(resolveDatabase(() => JSON.stringify(rows)));
  }
});

test("real prod renderer creates isolated bindings and leaves the demo unchanged; drift is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ezacto-review-"));
  try {
    const file = join(directory, "wrangler.jsonc");
    const template = await readFile(
      new URL("../entries/worker/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    await writeFile(file, template);
    execFileSync(
      process.execPath,
      [new URL("./render-wrangler-prod.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          ...renderEnvironment(id),
          EZACTO_WRANGLER_CONFIG: file,
        },
        stdio: "pipe",
      },
    );
    const rendered = await readFile(file, "utf8");
    const config = parseJsonc(rendered);
    assert.deepEqual(config.env.dev, parseJsonc(template).env.dev);
    assert.equal(
      (await assertReviewConfig(pathToFileURL(file))).databaseId,
      id,
    );
    for (const mutate of [
      (p) => {
        p.name = "ezacto-dev";
      },
      (p) => {
        p.workers_dev = true;
      },
      (p) => {
        p.vars.DEMO_MODE = "true";
      },
      (p) => {
        p.d1_databases[0].database_name = "ezacto-dev";
      },
      (p) => {
        p.r2_buckets[0].bucket_name = "ezacto-dev-attachments";
      },
      (p) => {
        p.queues.consumers[0].dead_letter_queue = "ezacto-dev-email-dlq";
      },
      (p) => {
        p.routes[0].pattern = "app.example.com";
      },
    ]) {
      const drifted = structuredClone(config);
      mutate(drifted.env.prod);
      await writeFile(file, JSON.stringify(drifted));
      await assert.rejects(assertReviewConfig(pathToFileURL(file)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2 permission fallback cannot masquerade as provisioned receipt storage", () => {
  assert.throws(() =>
    requireVerifiedR2({
      resources: [{ name: REVIEW.bucket, disposition: "assumed" }],
    }),
  );
  requireVerifiedR2({
    resources: [{ name: REVIEW.bucket, disposition: "created" }],
  });
});

test("deployed Worker must point DB to the resolved review database", async () => {
  for (const [binding, valid] of [
    [{ name: "DB", type: "d1", database_id: id }, true],
    [{ name: "DB", type: "d1", id }, true],
    [{ name: "DB", type: "d1", database_id: "different-database" }, false],
    [
      { name: "DB", type: "d1", database_id: id, id: "different-database" },
      false,
    ],
  ]) {
    const check = verifyDatabaseBinding(id, {
      accountId: "test-account",
      apiToken: "test-token",
      fetch: async (url, init) => {
        assert.equal(
          url,
          `https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts/${REVIEW.worker}/settings`,
        );
        assert.equal(init.redirect, "error");
        return Response.json({
          success: true,
          result: { bindings: [binding] },
        });
      },
    });
    if (valid) await check;
    else await assert.rejects(check);
  }
});

function mockServer({
  revoke = true,
  anonymousDenied = true,
  secureCookie = true,
  existingOwner = false,
  ownerUserId = 1,
  ownerProfile = "administrator",
  tokenStatus,
  loginStatus = 200,
  passwordEnrolled = true,
  passwordConflict = false,
} = {}) {
  let revoked = false;
  let bootstrapped = existingOwner;
  const paths = [];
  return {
    paths,
    request: async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://review.ezacto.io");
      assert.equal(init.redirect, "error");
      const path = parsed.pathname;
      paths.push(`${init.method} ${path}`);
      if (path.startsWith("/__ezacto/")) {
        // A used review workspace rejects exact first-run bootstrap retries.
        if (existingOwner && path === "/__ezacto/bootstrap")
          return Response.json({}, { status: 409 });
        if (path.endsWith("owner-password")) {
          if (passwordConflict) return Response.json({}, { status: 409 });
          passwordEnrolled = true;
        }
        bootstrapped = true;
        assert.equal(
          init.headers.authorization,
          `Bearer ${env.REVIEW_BOOTSTRAP_TOKEN}`,
        );
        return Response.json({
          data: {
            status: "ready",
            user_id: 1,
            profile: "administrator",
            ...(path.endsWith("owner-password")
              ? {
                  credential: "password",
                  owner_email: "reviewer@ezacto.example",
                }
              : {}),
          },
        });
      }
      if (path === "/auth/sign-in") {
        if (loginStatus !== 200 || !passwordEnrolled)
          return Response.json(
            {},
            { status: passwordEnrolled ? loginStatus : 401 },
          );
        assert.deepEqual(JSON.parse(init.body), {
          email: "reviewer@ezacto.example",
          password: env.REVIEW_OWNER_PASSWORD,
        });
        return Response.json(
          { data: { status: "authenticated", user_id: 1 } },
          {
            headers: {
              "set-cookie": `__Host-ezacto_session=test; HttpOnly; SameSite=Lax${secureCookie ? "; Secure" : ""}`,
            },
          },
        );
      }
      if (init.method === "DELETE") {
        assert.equal(path, "/api/v1/sessions/7");
        assert.equal(init.headers.origin, parsed.origin);
        revoked = revoke;
        return Response.json({ data: {} });
      }
      if (path === "/api/v1/sessions")
        return Response.json({
          data: [
            { current: false, id: 6 },
            { current: true, id: 7 },
          ],
        });
      if (init.headers.authorization && (!bootstrapped || tokenStatus))
        return Response.json({}, { status: tokenStatus ?? 401 });
      const authenticated =
        (init.headers.cookie && !revoked) || init.headers.authorization;
      if (!authenticated)
        return Response.json({}, { status: anonymousDenied ? 401 : 200 });
      return Response.json({
        data: {
          user_id: ownerUserId,
          profile: ownerProfile,
          authentication: { kind: init.headers.cookie ? "session" : "token" },
        },
      });
    },
  };
}

test("bootstrap exercises exact retry, private login, token access and session revocation", async () => {
  const server = mockServer();
  await bootstrapReview(env, server.request);
  assert.equal(
    server.paths.filter((path) => path === "POST /__ezacto/bootstrap").length,
    2,
  );
  assert.equal(
    server.paths.filter(
      (path) => path === "POST /__ezacto/bootstrap/owner-password",
    ).length,
    2,
  );
  assert.ok(server.paths.includes("DELETE /api/v1/sessions/7"));
  assert.equal(server.paths.at(-1), "GET /api/v1/expenses");
});

test("upgrade preserves a used owner workspace without repeating first-run bootstrap", async () => {
  const server = mockServer({ existingOwner: true });
  await bootstrapReview(env, server.request);
  assert.equal(server.paths[0], "GET /api/v1/whoami");
  assert.equal(
    server.paths.some((path) => path === "POST /__ezacto/bootstrap"),
    false,
  );
  assert.ok(server.paths.includes("POST /auth/sign-in"));
  assert.ok(server.paths.includes("DELETE /api/v1/sessions/7"));
  assert.equal(server.paths.at(-1), "GET /api/v1/expenses");
});

for (const failure of [
  { ownerUserId: 2 },
  { ownerProfile: "member" },
  { tokenStatus: 403 },
  { tokenStatus: 500 },
  { loginStatus: 401 },
]) {
  test(`upgrade rejects failed owner verification without repeating first-run bootstrap: ${JSON.stringify(failure)}`, async () => {
    const server = mockServer({ existingOwner: true, ...failure });
    await assert.rejects(bootstrapReview(env, server.request));
    assert.equal(
      server.paths.some((path) => path === "POST /__ezacto/bootstrap"),
      false,
    );
  });
}

test("upgrade recovers password enrollment interrupted after owner creation", async () => {
  const server = mockServer({ existingOwner: true, passwordEnrolled: false });
  await bootstrapReview(env, server.request);
  assert.equal(server.paths.includes("POST /__ezacto/bootstrap"), false);
  assert.ok(
    server.paths.indexOf("POST /__ezacto/bootstrap/owner-password") <
      server.paths.indexOf("POST /auth/sign-in"),
  );
  assert.ok(server.paths.includes("DELETE /api/v1/sessions/7"));
});

test("existing password mismatch stops at the guarded enrollment endpoint", async () => {
  const server = mockServer({ existingOwner: true, passwordConflict: true });
  await assert.rejects(bootstrapReview(env, server.request));
  assert.deepEqual(server.paths, [
    "GET /api/v1/whoami",
    "POST /__ezacto/bootstrap/owner-password",
  ]);
});

test("revoked bootstrap token cannot overwrite a used review workspace", async () => {
  const server = mockServer({ existingOwner: true, tokenStatus: 401 });
  await assert.rejects(bootstrapReview(env, server.request));
  assert.deepEqual(server.paths, [
    "GET /api/v1/whoami",
    "POST /__ezacto/bootstrap",
  ]);
});

for (const failure of [
  { revoke: false },
  { anonymousDenied: false },
  { secureCookie: false },
]) {
  test(`bootstrap fails when security acceptance fails: ${JSON.stringify(failure)}`, async () => {
    await assert.rejects(bootstrapReview(env, mockServer(failure).request));
  });
}

test("workflow gates main, verification, secrets before deployment, and bootstrap removal on owner success", async () => {
  const source = await readFile(
    new URL("../.github/workflows/deploy-app-review.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /\n  (push|pull_request):/);
  assert.match(source, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(source, /needs: verify/);
  assert.match(source, /environment: app-review/);
  assert.ok(
    source.indexOf("wrangler secret bulk") < source.indexOf("wrangler deploy"),
  );
  assert.match(source, /if: steps.owner.outcome == 'success'/);
  assert.doesNotMatch(
    source,
    /secrets\.(API_CURSOR_SIGNING_KEY|EZACTO_BOOTSTRAP_TOKEN|AWS_ACCESS_KEY_ID)/,
  );
});

// Exercise the actual CLI boundary, including native fetch/JSON exceptions.
test("bootstrap CLI never logs private transport or parser error details", () => {
  const script = new URL("./bootstrap-app-review.mjs", import.meta.url);
  for (const transport of [
    'async () => { throw new Error("private-response-sentinel") }',
    'async () => new Response("private-response-sentinel", {status: 200})',
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      globalThis.fetch = ${transport};
      process.argv[1] = ${JSON.stringify(script.pathname)};
      await import(${JSON.stringify(script.href)});
    `,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Review bootstrap failed/);
    assert.doesNotMatch(
      result.stderr + result.stdout,
      /private-response-sentinel/,
    );
  }
});
