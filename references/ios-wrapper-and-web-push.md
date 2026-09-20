# Push notifications across an iOS wrapper app and installed web apps

*Load before adding push notifications to a product that ships BOTH a native iOS wrapper (WKWebView) and an installed web app (PWA on other platforms, or the same web app added to Home Screen without the wrapper). This is the class of bug where the notification code "works" in every unit sense and the phone never buzzes.*

## Rule 1: web push does not exist inside a WKWebView — decide the transport before writing any code

On iOS, Web Push (the `PushManager` / service-worker `push` event pipeline `references/push-delivery-and-service-worker.md` describes) is only available to a web app the user installed from Safari to the Home Screen. A web page rendered inside a native wrapper's `WKWebView` — even the identical origin, even with a registered service worker — cannot receive it. There is no fallback and no capability flag to detect around it; it is simply absent.

If the product ships a native wrapper app, that wrapper must deliver notifications through APNs (Apple Push Notification service) as a native app. The web page inside it is not a delivery surface. Decide this at design time, not after the web push code "doesn't fire" on a device:

- Web app installed to Home Screen (no wrapper) → Web Push, per `references/push-delivery-and-service-worker.md`.
- Native iOS wrapper app → APNs, native `UNUserNotificationCenter` registration, this file.
- Both ship for the same product → both transports exist server-side, routed per installation (Rule 7).

## Rule 2: Apple setup order — everything is scriptable except downloading the key

Getting APNs working requires, in order:

1. **Enable the `PUSH_NOTIFICATIONS` capability on the App ID** via the App Store Connect API — no portal click needed:
   ```
   POST /v1/bundleIdCapabilities
   ```
   with the capability type for push notifications, scoped to the app's registered bundle ID resource.
2. **Add `aps-environment` to the app's entitlements.** Use `production` for TestFlight and App Store builds — **TestFlight delivers through the production APNs host, not sandbox.** A build entitled for `development` will silently fail to receive pushes once distributed through TestFlight; this is a common source of "it worked from Xcode, not from TestFlight."
3. **Create the APNs auth key in the developer portal UI**, at `developer.apple.com/account/resources/authkeys/list`. There is no API for this step: the App Store Connect API has no endpoint for APNs keys, and `/v1/certificates` has no APNs key type. This is the one manual step in an otherwise scriptable pipeline.

## Rule 3: the portal's Configure step blocks silently until two dropdowns are set

Since 2025, creating the key is not enough — the portal requires configuring it before it can be registered. On the APNs row, click **Configure** and set:

- **Environment**: Sandbox & Production
- **Key Restriction**: Team Scoped

These are `<select>` elements on the configuration page. Skipping them does not error immediately — the form silently refuses to let the key proceed, surfacing only "This service must have environment and type configured" when you try to continue. If APNs key creation seems stuck, this is almost always why.

## Rule 4: the `.p8` downloads exactly once — a scripted click is not enough

Apple deletes its own copy of the private key after the one download. This step resists automation: driving the Download button through browser automation (AppleScript `execute javascript`, a synthetic DOM click) reported success in the page but produced no file on disk and no entry in the browser's download list. A real human click was required.

Budget for this as a manual step:

- Have a human click Download, or
- If scripting the click, **verify the `.p8` file actually exists on disk** before moving on — do not trust a green return code or an in-page success message as proof of download. Same discipline as any "did the file actually land" check: assume it didn't until you can `stat` it.

## Rule 5: the provider JWT needs `ieee-p1363`, and reuse it — don't mint per notification

The APNs provider token is a JWT: header `{alg: "ES256", kid: <key id>}`, claims `{iss: <team id>, iat: <now>}`, signed with the `.p8` key. In Node, the default DER signature encoding is rejected by Apple — sign with:

```js
crypto.sign(null, Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
```

Two operational rules follow from how Apple treats this token:

- **Reuse the token for under an hour.** Apple rate-limits token minting; generating a fresh JWT per notification gets throttled.
- **Keep one HTTP/2 session open** to the APNs host. A new connection per notification is treated as abuse, not as parallelism.

**Cheap end-to-end credential check that needs no real device:** send a notification to an all-zeros device token (`"0000...0000"`, 64 hex chars) and read the response.
- `BadDeviceToken` — the key, key id, team id, and topic are all correct; only the (fake) token was rejected. This is success for a credential check.
- `InvalidProviderToken` — the key, key id, or team id is wrong. Fix before wiring up a real device.

This turns "did I configure APNs right" from "install the app on a phone and wait" into a single curl-equivalent request.

## Rule 6: RFC 8291 web push encryption needs no library, and needs verification against the RFC's own vectors

For the installed-web-app (non-wrapper) side, Web Push needs no SDK: VAPID auth is the same ES256/`ieee-p1363` JWT code as Rule 5 (`aud` = the push service's origin, not the subscription URL), and the payload encryption is RFC 8291's `aes128gcm` scheme, buildable from `node:crypto`'s `createECDH`, `hkdfSync`, and `aes-128-gcm` cipher directly.

Before trusting your implementation:

- **Verify the key/nonce derivation against the worked example in RFC 8291 §5** — the spec publishes the exact intermediate IKM, CEK, and NONCE values for a known input. Reproduce those exact intermediate values, not just a final ciphertext.
- **Round-trip decrypt your own output** the way a browser's push service would, rather than only comparing your ciphertext against an expected string byte-for-byte. If a full-ciphertext comparison fails, you cannot tell whether the crypto is wrong or the expected string was mistyped; comparing IKM/CEK/NONCE individually tells you exactly which derivation step broke.

## Rule 7: one registry keyed by install, not by push address, routed to whichever surface is actually visible

A product with several installed surfaces for the same person (phone wrapper app, laptop installed web app) must not turn one event needing attention into several buzzes. Two things make this hard if not designed for:

- **Push addresses rotate.** Both an APNs device token and a Web Push subscription can change for the same install (OS updates, browser storage eviction, re-registration). Keying the send-to list by push address instead of by install identity accumulates dead rows and can double-register the same physical install.
- **"Send to everyone registered" defeats the purpose of managing attention.** If the phone and the laptop are both open, sending to both buzzes both.

Shape that avoids this:

1. **One registry, keyed by install** (not by push token/subscription). Each install record holds its current push address, refreshed on re-registration.
2. **Each surface reports "I am visible" on a cheap heartbeat** while its page/app is in the foreground — not a persistent connection, a lightweight periodic signal.
3. **Route delivery to surfaces active within the last few minutes.** When no surface is currently active, send to all registered installs rather than lose the notification — the fallback direction is "notify everywhere," never "notify nowhere."
4. **Claim each attention-worthy event once in storage** before sending, so a reconnecting event stream (a client that dropped and resubscribed) cannot cause the same event to be notified twice.

## Rule 8: ask for permission at first use, not behind a settings toggle

A permission prompt the user has to go find in Settings is a feature nobody turns on. The platforms differ in what they allow:

- **Native iOS** can request notification permission without a preceding user gesture — ask as part of the flow that will actually use it (e.g., right after the action whose response the notification will announce).
- **Browsers, Safari especially, require a user gesture** to request permission. If the natural moment to ask isn't itself a click, arm a one-time listener on the next click/tap rather than rendering a dedicated "Enable notifications" button as the primary path — the button is a fallback, not the design.

## Rule 9: only notify for the signal that already means "a human is needed"

Don't invent a second attention channel. If the product already has a concept of "this needs the person's attention" (an explicit signal, a status, a queue), push notifications are a delivery mechanism for THAT signal — not a new trigger surface with its own rules for when to fire. Reusing the existing signal keeps the notification meaningful (one buzz = one thing that actually needs you) and keeps the two transports (Rule 1) consistent: whatever decides "notify" is transport-agnostic, and Rules 5–7 are just how the decision reaches the device.

## Sources

- Thinkering repo, 2026-09-20: `apps/ios/Sources/PushNotifications.swift`, `packages/adapters/src/apns-sender.ts`, `packages/adapters/src/web-push-sender.ts`, `packages/adapters/src/notification-courier.ts`, `packages/adapters/src/notification-targets.ts`, `apps/web/src/notifications.ts`.
- Apple — [App Store Connect API: Enable a Capability](https://developer.apple.com/documentation/appstoreconnectapi/register_a_bundle_id_for_your_app) and [`bundleIdCapabilities`](https://developer.apple.com/documentation/appstoreconnectapi/bundleidcapabilities).
- Apple — [Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- RFC 8291 — [Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291), §5 (worked test vector).
- RFC 8292 — [Voluntary Application Server Identification (VAPID) for Web Push](https://www.rfc-editor.org/rfc/rfc8292).
