import { pathToFileURL } from "node:url";
import { REVIEW, reviewSecrets } from "./app-review-instance.mjs";

// These are fictional identities, not mailboxes. Email/OIDC providers are absent.
const identity = {
  organization_name: "eZacto Review",
  owner_first_name: "App",
  owner_last_name: "Reviewer",
  owner_email: "reviewer@ezacto.example",
};

export async function bootstrapReview(env, request = fetch) {
  const secrets = reviewSecrets(env);
  const origin = `https://${REVIEW.host}`;
  async function call(
    path,
    { method = "GET", body, cookie, bearer, status = 200 } = {},
  ) {
    const response = await request(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie, origin } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      !(Array.isArray(status)
        ? status.includes(response.status)
        : response.status === status)
    )
      throw new Error(`Review ${method} ${path}: HTTP ${response.status}`);
    return response;
  }
  const bearer = secrets.EZACTO_BOOTSTRAP_TOKEN;
  // Bootstrap is an exact first-run retry, not an upgrade operation: ordinary
  // profile edits and additional users/tokens intentionally make it conflict.
  // Authenticate the existing owner first. Only an unauthenticated token may
  // try bootstrap, whose database guards still refuse changed identity state.
  const existing = await call("/api/v1/whoami", {
    bearer,
    status: [200, 401],
  });
  const needsBootstrap = existing.status === 401;
  if (!needsBootstrap) {
    const owner = await existing.json();
    if (
      owner.data?.user_id !== 1 ||
      owner.data.profile !== "administrator" ||
      owner.data.authentication?.kind !== "token"
    ) {
      throw new Error("Review existing owner identity mismatch");
    }
  }
  for (let retry = 0; retry < 2; retry += 1) {
    if (needsBootstrap) {
      const result = await (
        await call("/__ezacto/bootstrap", {
          method: "POST",
          body: identity,
          bearer,
        })
      ).json();
      if (
        result.data?.status !== "ready" ||
        result.data.user_id !== 1 ||
        result.data.profile !== "administrator"
      ) {
        throw new Error("Review bootstrap identity mismatch");
      }
    }
    // This endpoint inserts a missing credential or verifies an exact retry;
    // it cannot replace an existing password. It also recovers an interrupted
    // first run that created the owner/token but never enrolled the password.
    const password = await (
      await call("/__ezacto/bootstrap/owner-password", {
        method: "POST",
        bearer,
        body: { password: env.REVIEW_OWNER_PASSWORD },
      })
    ).json();
    if (
      password.data?.status !== "ready" ||
      password.data.owner_email !== identity.owner_email ||
      password.data.user_id !== 1 ||
      password.data.credential !== "password"
    ) {
      throw new Error("Review password enrollment mismatch");
    }
  }
  const response = await call("/auth/sign-in", {
    method: "POST",
    body: { email: identity.owner_email, password: env.REVIEW_OWNER_PASSWORD },
  });
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((value) =>
    value.startsWith("__Host-ezacto_session="),
  );
  if (
    !sessionCookie ||
    !/;\s*HttpOnly/i.test(sessionCookie) ||
    !/;\s*Secure/i.test(sessionCookie) ||
    !/;\s*SameSite=Lax/i.test(sessionCookie)
  )
    throw new Error("Secure review session cookie missing");
  const cookie = sessionCookie.split(";")[0];
  const me = await (await call("/api/v1/whoami", { cookie })).json();
  if (
    me.data?.user_id !== 1 ||
    me.data.profile !== "administrator" ||
    me.data.authentication?.kind !== "session"
  ) {
    throw new Error("Review session identity mismatch");
  }
  const tokenMe = await (await call("/api/v1/whoami", { bearer })).json();
  if (
    tokenMe.data?.user_id !== 1 ||
    tokenMe.data.authentication?.kind !== "token"
  ) {
    throw new Error("Review token identity mismatch");
  }
  const sessions = await (await call("/api/v1/sessions", { cookie })).json();
  const current = sessions.data.filter((session) => session.current === true);
  if (current.length !== 1 || !Number.isSafeInteger(current[0].id))
    throw new Error("Review session not identified");
  await call(`/api/v1/sessions/${current[0].id}`, { method: "DELETE", cookie });
  await call("/api/v1/whoami", { cookie, status: 401 });
  await call("/api/v1/whoami", { status: 401 });
  await call("/api/v1/expenses", { status: 401 });
  console.log(
    `Review owner ready: ${needsBootstrap ? "exact bootstrap retry" : "existing owner preserved"}, password, token, session revocation and anonymous access checks passed`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  bootstrapReview(process.env).catch(() => {
    // Transport/parser exceptions may contain authenticated response excerpts.
    console.error(
      "Review bootstrap failed; verify private configuration and server health",
    );
    process.exitCode = 1;
  });
}
