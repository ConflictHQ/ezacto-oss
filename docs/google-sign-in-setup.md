# Google sign-in: operator setup

Google sign-in uses a server-side OAuth/OIDC flow. Configure the Google client and the eZacto instance separately, then test an actual login before changing your administrator's existing login method.

## Provider setup

1. In your Google Cloud project, configure the Google Auth Platform application's branding, audience and contact information. For testing, add the controlled test users allowed by the app's audience settings.
2. Create an OAuth client of type **Web application**. Use a separate client for each independently operated environment.
3. Register this exact authorized redirect URI, replacing the example host with your canonical application host:

   ```text
   https://app.example.com/auth/oidc/google/callback
   ```

4. Save the client ID and secret in the deployment secret store. The flow requests `openid`, `email` and `profile`; Google sign-in does not require Drive, Gmail, Analytics or advertising account scopes.

Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) describes client creation and exact redirect matching. Do not add an OAuth Playground callback as the application's callback.

## Deployment and verification

Set both `OIDC_GOOGLE_CLIENT_ID` and `OIDC_GOOGLE_CLIENT_SECRET`. For the Worker, set the GitHub environment variable `OIDC_REDIRECT_ORIGIN` to the canonical HTTPS origin (no path/query); production requires it. Set it explicitly for an independently hosted development Worker too: the stock `dev` fallback points at the public demo. The container normally uses its HTTPS `APP_BASE_URL` with the default `ENVIRONMENT=container`; changing it to `prod` without an explicit supported redirect-origin path causes OIDC configuration failure. Do not rely on untrusted forwarded headers to choose the callback. Check the generated authorization request against the exact URI registered at Google.

Follow [credential deployment](integrations.md), then check **Settings → Company → Ways in** for the Google method. Open a separate browser session, start Google sign-in, select the expected Google account, and confirm the resulting eZacto user, profile and return location. Test cancellation too. Provider authentication does not override the instance's account-provisioning or disabled-user policy.

| Symptom | Check |
| --- | --- |
| `redirect_uri_mismatch` | Exact scheme, hostname, port, path and trailing slash in the outgoing authorization URL versus Google configuration |
| Google blocks the selected test user | OAuth audience/publishing state and allowed test users in the Google project |
| Google is absent or reports unavailable | Both credentials reached this deployment; sign-in method is enabled |
| Provider authentication succeeds but eZacto denies entry | Existing user state, provisioning policy and required verified profile information |
| Callback state check fails | Start again in the same browser; preserve cookies across the redirect and use the canonical hostname |

Rotate the client secret through the environment and redeploy before retiring the previous secret when supported. To disable the method, prove another working administrator login and turn Google off in Ways in. See [sign-in policy and lockout protections](security.md).

Implementation reference: `packages/api/src/oidc.ts`, `.dev.vars.example`, `.github/workflows/deploy.yml`.
