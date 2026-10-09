# Sign in with Apple: operator setup

Apple sign-in has two distinct deployment paths. The current OSS endpoint accepts native-app identity tokens at `POST /auth/apple`. Browser Sign in with Apple is being developed separately; registering a Services ID alone does not enable a browser button on an arbitrary self-hosted instance.

## What is available

| Path | Current operator contract |
| --- | --- |
| Native app → OSS instance | Configure `APPLE_CLIENT_ID`, then enable Apple in the instance's sign-in policy |
| Browser sign-in on first-party websites | Separate rollout with a central credential service; not part of the current released setup described here |
| Browser sign-in on an independent domain | Requires an integration supporting the operator's audience and domain; the pending first-party implementation does not accept arbitrary domains |

This status describes the OSS endpoint contract as audited on 2026-10-09, not a promise that every mobile build is compatible. Match the mobile and server releases before enabling Apple login. Newer lifecycle-enabled mobile builds require a positive Apple lifecycle capability before opening the native prompt. After Apple authorization, they require a signed binding receipt before completing workspace sign-in; their compatible OSS server integration is still pending. Deploying the central native credential service alone does not satisfy that server gate. An `APPLE_CLIENT_ID`-only endpoint cannot be assumed sufficient for the latest mobile candidate. Do not copy unreleased `APPLE_WEB_*` settings into a deployed version and assume it supports them.

## Native setup

1. Identify the native application used by your users. If you build your own app, use an Apple Developer account and an explicit App ID with Sign in with Apple enabled; add the capability to the native app. Follow [Apple's capability instructions](https://developer.apple.com/documentation/xcode/configuring-sign-in-with-apple).
2. Set `APPLE_CLIENT_ID` to that app's exact bundle identifier. The bundled eZacto app uses `com.ezacto.app`. Treat this as an audience allowlist, not as a secret or a login credential. Keep web Services IDs out of the native audience configuration.
3. Deploy using the [credential deployment guide](integrations.md). The container reads the same variable. Keep the normal instance URL and administrator recovery method configured.
4. Open **Settings → Company → Ways in** as an administrator. Confirm Apple is configured and enabled. The native application owns the Apple prompt; the current browser login screen has no Apple button.
5. Use a controlled Apple account through the native app, pointing it at this instance. Check the resulting eZacto user and permissions. A successful Apple identity check does not override the instance's provisioning policy.

The current native OSS endpoint verifies Apple's signed identity token. It does not require an Apple private signing key in the OSS server configuration. An App Store Connect API key is not a Sign in with Apple key.

## Preparing for a supported browser deployment

Follow these steps only alongside the browser integration's release-specific operator runbook:

1. Enable Sign in with Apple on a primary App ID in the Apple Developer account.
2. Create a Services ID for the web service, associate it with the primary App ID, and register the exact website domains and HTTPS return URLs required by that integration. An app bundle identifier and a Services ID serve different audiences.
3. Create the Sign in with Apple key that the server's authorization-code exchange needs. Keep the `.p8` key, key ID and team configuration in the designated credential service or secret store. Never put the private key in a frontend bundle.
4. Configure the approved server integration, then verify callback state, account mapping, cancellation and account/grant cleanup before enabling its login button. Test native/web identity correspondence with controlled accounts; matching email addresses are not proof of the same provider subject.

Apple documents the [Services ID/domain setup](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web) and [environment and key requirements](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple). The first-party browser rollout uses a central service with a fixed deployment policy; these Apple portal steps do not make that service available to independent installations.

## Hide My Email and delivery

If you send messages to Apple relay addresses, register your outbound email sources with Apple and authenticate the sending domain. Test delivery to a controlled relay address using the actual transport. Verification of a domain in SES or another mail provider does not register it with Apple. See [Apple's private email relay guide](https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service) and [eZacto email setup](email-setup.md).

## Troubleshooting and disablement

| Symptom | Check |
| --- | --- |
| Apple method is not configured | `APPLE_CLIENT_ID` reached the runtime deployed to the instance the app uses |
| `404 sign_in_method_unavailable` | Apple is disabled in Ways in |
| `apple_authentication_failed` | The native token is genuine, current, and addressed to the configured app; do not copy tokens into support tickets |
| `apple_profile_incomplete` | Required profile information was unavailable for a new account; Apple's first authorization and subsequent sign-ins can provide different profile data |
| `provisioning_not_permitted` | The instance does not permit provisioning that identity; do not weaken the policy merely to make a test pass |
| Browser button is absent | The deployed release may support native Apple sign-in only |
| Relay email never arrives | Registered sender, domain authentication, provider delivery result and the Apple user's forwarding choice |

To stop new Apple sign-ins, disable the method in Ways in after proving another administrator login. Do not present that operation as Apple grant revocation or account erasure. Removing private keys or custody configuration from a newer credential-service deployment can prevent cleanup of existing grants; follow that deployment's specific rotation and closure runbook.

Implementation reference: `packages/api/src/apple.ts`, `.dev.vars.example`, and [sign-in policy](security.md).
