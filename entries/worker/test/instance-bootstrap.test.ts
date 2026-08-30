import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

const bootstrapToken = `ezacto_abcdefghijklmnop_${"A".repeat(43)}`;
const wrongToken = `ezacto_abcdefghijklmnop_${"B".repeat(43)}`;
const ownerPassword = "correct horse battery staple";
const cursorSecret = encodeBase64Url(new Uint8Array(32).fill(0x42));
const identity = {
  organization_name: "Conflict",
  owner_first_name: "Luis",
  owner_last_name: "Herrera",
  owner_email: "luis@example.com",
};

const miniflares: Miniflare[] = [];

const harness = async (enabled = true) => {
  const bundled = await build({
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true,
    conditions: ["development"],
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: "test",
      RELEASE: "instance-bootstrap-test",
      ...(enabled ? { EZACTO_BOOTSTRAP_TOKEN: bootstrapToken } : {}),
    },
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    modules: true,
    script: bundled.outputFiles[0]!.text,
  });
  miniflares.push(miniflare);
  return {
    database: await miniflare.getD1Database("DB"),
    request: (path: string, init?: RequestInit): Promise<Response> =>
      miniflare.dispatchFetch(
        new URL(path, "https://worker.test").toString(),
        init as never,
      ) as unknown as Promise<Response>,
  };
};

const post = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

afterEach(async () => {
  await Promise.all(
    miniflares.splice(0).map(async (miniflare) => miniflare.dispose()),
  );
});

describe("Worker operator bootstrap", () => {
  it("[e2e:cli-log] seeds once, rejects mismatch, authenticates whoami, and never returns the bearer", async () => {
    const { database, request } = await harness();
    const responses: string[] = [];

    const unauthorized = await request(
      "/__ezacto/bootstrap",
      post(wrongToken, identity),
    );
    responses.push(await unauthorized.text());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'Bearer realm="ezacto-bootstrap"',
    );

    const invalid = await request(
      "/__ezacto/bootstrap",
      post(bootstrapToken, { ...identity, unexpected: true }),
    );
    responses.push(await invalid.text());
    expect(invalid.status).toBe(422);

    const seeded = await request(
      "/__ezacto/bootstrap",
      post(bootstrapToken, identity),
    );
    const seededBody = await seeded.text();
    responses.push(seededBody);
    expect(seeded.status).toBe(200);
    expect(JSON.parse(seededBody)).toEqual({
      data: { status: "ready", user_id: 1, profile: "administrator" },
    });

    const exactRetry = await request(
      "/__ezacto/bootstrap",
      post(bootstrapToken, identity),
    );
    responses.push(await exactRetry.text());
    expect(exactRetry.status).toBe(200);

    const mismatched = await request(
      "/__ezacto/bootstrap",
      post(bootstrapToken, { ...identity, owner_email: "other@example.com" }),
    );
    responses.push(await mismatched.text());
    expect(mismatched.status).toBe(409);
    expect(JSON.parse(responses.at(-1)!)).toMatchObject({
      error: { code: "bootstrap_state_conflict" },
    });

    const whoami = await request("/api/v1/whoami", {
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    const whoamiBody = await whoami.text();
    responses.push(whoamiBody);
    expect(whoami.status).toBe(200);
    expect(JSON.parse(whoamiBody)).toMatchObject({
      data: {
        user_id: 1,
        profile: "administrator",
        authentication: { kind: "token", token_id: 1 },
      },
    });

    const beforeEnrollment = await request("/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: identity.owner_email,
        password: ownerPassword,
      }),
    });
    expect(beforeEnrollment.status).toBe(401);

    const unauthorizedPassword = await request(
      "/__ezacto/bootstrap/owner-password",
      post(wrongToken, { password: ownerPassword }),
    );
    responses.push(await unauthorizedPassword.text());
    expect(unauthorizedPassword.status).toBe(401);

    const enrolled = await request(
      "/__ezacto/bootstrap/owner-password",
      post(bootstrapToken, { password: ownerPassword }),
    );
    const enrolledBody = await enrolled.text();
    responses.push(enrolledBody);
    expect(enrolled.status).toBe(200);
    expect(JSON.parse(enrolledBody)).toEqual({
      data: {
        status: "ready",
        credential: "password",
        user_id: 1,
        profile: "administrator",
        owner_email: identity.owner_email,
      },
    });

    const exactPasswordRetry = await request(
      "/__ezacto/bootstrap/owner-password",
      post(bootstrapToken, { password: ownerPassword }),
    );
    responses.push(await exactPasswordRetry.text());
    expect(exactPasswordRetry.status).toBe(200);

    const differentPassword = await request(
      "/__ezacto/bootstrap/owner-password",
      post(bootstrapToken, { password: "a different valid password" }),
    );
    responses.push(await differentPassword.text());
    expect(differentPassword.status).toBe(409);
    expect(JSON.parse(responses.at(-1)!)).toMatchObject({
      error: { code: "bootstrap_password_state_conflict" },
    });

    const signedIn = await request("/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: identity.owner_email,
        password: ownerPassword,
      }),
    });
    expect(signedIn.status).toBe(200);
    const sessionCookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(sessionCookie).toContain("__Host-ezacto_session=");

    const browserWhoami = await request("/api/v1/whoami", {
      headers: { cookie: sessionCookie },
    });
    expect(browserWhoami.status).toBe(200);
    expect(await browserWhoami.json()).toMatchObject({
      data: {
        user_id: 1,
        profile: "administrator",
        authentication: { kind: "session" },
      },
    });

    const sessions = await request("/api/v1/sessions", {
      headers: { cookie: sessionCookie },
    });
    const current = ((await sessions.json()) as { data: Array<{ id: number }> })
      .data[0];
    expect(current).toBeDefined();
    const logout = await request(`/api/v1/sessions/${current!.id}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie, origin: "https://worker.test" },
    });
    expect(logout.status).toBe(200);
    const revokedCookie = await request("/api/v1/whoami", {
      headers: { cookie: sessionCookie },
    });
    expect(revokedCookie.status).toBe(401);

    expect(responses.join("\n")).not.toContain(bootstrapToken);
    expect(responses.join("\n")).not.toContain("A".repeat(43));
    expect(responses.join("\n")).not.toContain(ownerPassword);
    expect(
      await database
        .prepare(`SELECT count(*) AS count FROM instance_bootstrap`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT credential_version, algorithm, version, iterations, memory_kib, time_cost, parallelism
             FROM user_passwords
            WHERE user_id = 1`,
        )
        .first(),
    ).toEqual({
      credential_version: 1,
      algorithm: 'argon2id',
      version: 19,
      iterations: null,
      memory_kib: 19_456,
      time_cost: 2,
      parallelism: 1,
    })
    expect(
      await database
        .prepare(`SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`)
        .first<{ id: string }>(),
    ).toEqual({ id: "0023_migration_import_authority" });
  }, 40_000);

  it("[security] remains unavailable when the temporary Worker secret is absent", async () => {
    const { request } = await harness(false);
    const response = await request(
      "/__ezacto/bootstrap",
      post(bootstrapToken, identity),
    );
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({
      error: { code: "internal_error" },
    });
    expect(body).not.toContain(bootstrapToken);

    const password = await request(
      "/__ezacto/bootstrap/owner-password",
      post(bootstrapToken, { password: ownerPassword }),
    )
    expect(password.status).toBe(503)
    expect(await password.text()).not.toContain(ownerPassword)
  }, 20_000)

  it('[security] bounds concurrent Worker KDFs, fails overload closed, and recovers', async () => {
    const { request } = await harness()
    const seeded = await request(
      '/__ezacto/bootstrap',
      post(bootstrapToken, identity),
    )
    expect(seeded.status).toBe(200)

    // Materialize each streamed body inside its request task so concurrent
    // dispatch responses are not retained past their fetch lifecycle.
    const enrollments = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const response = await request(
          '/__ezacto/bootstrap/owner-password',
          post(bootstrapToken, { password: ownerPassword }),
        )
        return {
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
          body: await response.text(),
        }
      }),
    )
    expect(enrollments.some((response) => response.status === 503)).toBe(true)
    expect(
      enrollments.every(
        (response) => response.status === 200 || response.status === 503,
      ),
    ).toBe(true)
    for (const enrollment of enrollments) {
      expect(enrollment.body).not.toContain(ownerPassword)
      if (enrollment.status === 503) {
        expect(enrollment.retryAfter).toBe('1')
        expect(JSON.parse(enrollment.body)).toMatchObject({
          error: { code: 'internal_error' },
        })
      }
    }

    const enrollmentRetry = await request(
      '/__ezacto/bootstrap/owner-password',
      post(bootstrapToken, { password: ownerPassword }),
    )
    expect(enrollmentRetry.status).toBe(200)

    const signIns = await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const response = await request('/auth/sign-in', {
          method: 'POST',
          headers: {
            'cf-connecting-ip': `198.51.100.${index + 1}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: `unknown-${index}@example.test`,
            password: ownerPassword,
          }),
        })
        return {
          status: response.status,
          body: (await response.json()) as { error: { code: string } },
        }
      }),
    )
    expect(signIns.some((response) => response.status === 503)).toBe(true)
    expect(
      signIns.every(
        (response) => response.status === 401 || response.status === 503,
      ),
    ).toBe(true)
    for (const signIn of signIns) {
      expect(signIn.body.error.code).toBe(
        signIn.status === 401 ? 'invalid_credentials' : 'internal_error',
      )
    }

    const recovered = await request('/auth/sign-in', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '203.0.113.250',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: identity.owner_email,
        password: ownerPassword,
      }),
    })
    expect(recovered.status).toBe(200)
  }, 30_000)
})

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
