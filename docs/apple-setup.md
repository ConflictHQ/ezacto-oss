# Sign in with Apple: operator setup

Apple sign-in has two distinct deployment paths. The OSS endpoint accepts the official native app's Apple identity token and an independently verified credential-custody receipt at `POST /auth/apple`. Browser Sign in with Apple is being developed separately; registering a Services ID alone does not enable a browser button on an arbitrary self-hosted instance.

## What is available

| Path | Current operator contract |
| --- | --- |
| Native app → OSS instance | Use the official app, configure `APPLE_CLIENT_ID=com.ezacto.app` and a canonical HTTPS `APP_BASE_URL`, then enable Apple in the instance's sign-in policy |
| Browser sign-in on first-party websites | Separate rollout with a central credential service; not part of the current released setup described here |
| Browser sign-in on an independent domain | Requires an integration supporting the operator's audience and domain; the pending first-party implementation does not accept arbitrary domains |

This server source supports native lifecycle protocol version 1. Match the mobile and deployed server releases before enabling Apple login: the app checks `GET /auth/apple/native-capabilities` for `{available:true,lifecycle_version:1}` before opening the native prompt. It then obtains a signed, instance-bound custody receipt alongside the Apple identity token. Older identity-token-only clients or servers do not satisfy this contract; deploying the central service alone does not upgrade an older instance. See [credential lifecycle and recovery](apple-credential-lifecycle.md). Browser integration remains a separate release and deployment boundary.

## Native setup

1. Use a compatible release of the official eZacto iOS app. The pinned credential service supports its exact native audience, `com.ezacto.app`; a custom app bundle identifier is not supported by this native lifecycle integration.
2. Set `APPLE_CLIENT_ID=com.ezacto.app`. This is an audience allowlist, not a secret or a login credential. Keep web Services IDs out of the native audience configuration.
3. Set `APP_BASE_URL` to this instance's exact public HTTPS origin, with no trailing slash, path, query, fragment or credentials. Deploy using the [credential deployment guide](integrations.md); the container reads the same variables. Keep an independently tested administrator recovery method.
4. Open **Settings → Company → Ways in** as an administrator and enable Apple. Confirm the deployed capability response reports `available:true` and `lifecycle_version:1`. The native app owns the Apple prompt; browser support has its own deployment contract.
5. Use a controlled Apple account through the native app, pointing it at this instance. Check the resulting eZacto user and permissions. A custody receipt proves provider-token handling, not workspace membership: the instance still independently verifies the Apple identity and applies its linking and provisioning policy.
6. Verify the disposable account's closure and Apple cleanup using the [lifecycle runbook](apple-credential-lifecycle.md). Local access closure and verified Apple revocation are distinct results; do not use the stable reviewer or a real customer account for destructive testing.

The OSS server independently verifies Apple's signed identity token and the fixed credential service's origin-bound receipt, including matching provider subject and nonce. Every new native sign-in requires this receipt, even for an existing account. Historical missing-grant recovery does not permit identity-token-only login. The server needs no Apple private signing key, refresh token or service capability; those remain with the designated credential service and native recovery flow. An App Store Connect API key is not a Sign in with Apple key.

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
| Native capability is unavailable | Official native audience, canonical HTTPS `APP_BASE_URL`, enabled Ways in policy, and a compatible lifecycle-enabled server release |
| `apple_lifecycle_unavailable` | Required lifecycle configuration, credential storage and fixed issuer verification are available; inspect safe operator diagnostics rather than sharing tokens |
| `404 sign_in_method_unavailable` | Apple is disabled in Ways in |
| `apple_authentication_failed` | The native token is genuine, current, and addressed to the configured app; do not copy tokens into support tickets |
| `apple_profile_incomplete` | Required profile information was unavailable for a new account; Apple's first authorization and subsequent sign-ins can provide different profile data |
| `provisioning_not_permitted` | The instance does not permit provisioning that identity; do not weaken the policy merely to make a test pass |
| Browser button is absent | The deployed release may support native Apple sign-in only |
| Relay email never arrives | Registered sender, domain authentication, provider delivery result and the Apple user's forwarding choice |

To stop new Apple sign-ins, disable the method in Ways in after proving another administrator login. Do not present that operation as Apple grant revocation or account erasure. Removing private keys or custody configuration from a newer credential-service deployment can prevent cleanup of existing grants; follow that deployment's specific rotation and closure runbook.

Implementation reference: `packages/api/src/apple.ts`, `.dev.vars.example`, and [sign-in policy](security.md).
