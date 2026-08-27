# PWA specifics

*Load before touching manifest, service worker, passkey / WebAuthn, push subscription, HTML head, iOS-specific styles, or origin-aware beacons. Each item below is a specific fix for a specific bug pattern that shipped, hit a real device, and needed a targeted invariant.*

## Passkey / WebAuthn

### rpID scoping — the exact rule

The passkey `rpID` (Relying Party ID) can be set to the origin's own hostname OR to any registrable-domain suffix of it. So two sibling subdomains of the same registrable domain (`foo.example.com` and `bar.example.com`) CAN share credentials by both setting `rpID: "example.com"` explicitly. Two unrelated domains (`chess.tejas.nyc` and `twochairs.club`) cannot share credentials — different registrable domains.

**Implication:** if you serve the same app from two unrelated domains (canonical + alias), users create separate passkey accounts per domain. Accept this or pick ONE canonical rpID and 301 the alias. Never silently.

**Implication for subdomains:** if you plan to move the app from `chess.example.com` to `app.example.com` later, set `rpID: "example.com"` from day one — retrofitting is not free (existing credentials are still bound to their original rpID). Set it before the first passkey is created.

**Verify:** log the `rpID` you pass to `generateRegistrationOptions()` on the server. If it defaults to `new URL(request.url).hostname` and you later want subdomain sharing, you'll be re-onboarding every user.

Sources: WebAuthn Level 2 spec §5.1.3; [web.dev — Understanding the passkey RP ID](https://web.dev/articles/webauthn-rp-id).

### rpName comes from server env, not the client

The passkey display string in the OS dialog ("Sign in to X?") comes from the server-side `rpName` you pass to `generateRegistrationOptions()` / `generateAuthenticationOptions()`. Set it from an env var:

```jsonc
// wrangler.jsonc
"vars": {
  "APP_NAME": "two chairs"
}
```

```ts
// server
const options = await generateRegistrationOptions({
  rpID: new URL(request.url).hostname,
  rpName: env.APP_NAME,
  // ...
});
```

If `rpName` is empty, iOS shows a broken dialog with the domain instead. Test on device.

### Origin strategy — decide BEFORE the first passkey

Before shipping WebAuthn, answer these in `docs/state-machines.md`:

- **Canonical auth origin.** What is the single hostname that `rpID` will be scoped to? If it's a registrable-domain suffix (`example.com`), name the sibling subdomains it will cover.
- **Duplicate-domain behavior.** If you have a canonical + alias (like `twochairs.club` + `chess.tejas.nyc`) that aren't sibling subdomains of a shared registrable domain, either 301 the alias to the canonical OR accept that users create separate accounts per domain. Never leave both live and quiet — accounts fork silently and users lose their credentials moving between them.
- **Rename resilience.** If the app might move from `foo.example.com` to `app.example.com` later, set `rpID: "example.com"` from day one.
- **Add-passkey flow.** How does a user with an existing account on device A add a passkey on device B? Explicit "add another passkey" flow, or reuse the sign-in flow's "no credential — start registration" branch?
- **Account recovery.** If a user loses all devices (all passkeys), what's the recovery path? Email? SMS? Recovery code? "None" is a legitimate answer for a private app, but write it down.

Ship the decisions in the ledger; without them, day-N you'll be looking at four accounts per person and unable to consolidate.

### Domain / brand confusion checklist

For any product with a distinctive spoken name, run through these before committing to a domain:

- **Typed form.** Do users spell it right? "sitacross" reads as "sitacroce" to some.
- **Spoken form.** If told the name, do users find the correct URL? "two chairs" → `twochairs.com`? `2chairs.com`? `2chair.app`? `sitacross.me`?
- **Numeric / word variants.** Does your brand have both a numeric ("2 chairs") and word ("two chairs") interpretation? Register both and 301.
- **Typo domains.** Own the top 3 likely typos or accept that a competitor / squatter will.
- **Redirect policy.** Every alias 301s to the canonical UNLESS the alias is a first-class origin with its own passkey account (see above). Never both a and b live serving the same content without a decision.
- **Passkey impact.** A rename after launch strands existing accounts on the old rpID. Rename before launch or set `rpID` to a rename-resilient suffix.
- **Manifest identity impact.** `manifest.id` (a stable identifier the browser uses to dedupe installations) survives a URL move but only if you set it. Set it from day one to a stable string; a rename otherwise creates a "different app" in the browser's eyes and re-installs from scratch.

### Handle probe — abuse budget

An unauthenticated handle-probe endpoint (`/api/auth/login/options`) that distinguishes "no such account" from "account exists" enables account enumeration. It also allocates auth-challenge state per probe.

**Mitigations, in priority order:**

1. **Rate limit per source IP.** A per-IP token bucket (10 requests / minute is a reasonable ceiling for a probe endpoint the UI uses on a 350ms debounce). Cloudflare Workers can use `Rate Limiting Rules` or a simple KV counter.
2. **Cleanup allocation-site.** Every options handler runs the TTL sweep before allocating (see `references/durable-objects.md` Rule 9). Prevents unbounded challenge accumulation from probe traffic.
3. **Consider indistinguishable errors** if enumeration is a real threat: return the same shape whether the account exists or not, and let the follow-up `verify` step reveal the truth. Loses the "morphing button label" UX but closes the enumeration channel.

For a private friends-only app enumeration is low-severity; for a public app it may be the primary abuse vector. Decide explicitly, write it in the ledger.

### Handle probe → morphing button (never separate flows)

Users don't know if they have an account. A single `Handle` input with a debounced probe (`/api/auth/login/options`) morphs the button label:
- No account with this handle → button reads `Sign up as @handle`.
- Account exists → button reads `Sign in as @handle`.

Reserve the button width so it doesn't jump when the label changes. Submit runs `startAuthentication` or `startRegistration` based on the probed flow.

Never require the user to pick between two buttons up-front. The whole point of passkeys is the flow disappears — one input, one button.

### Error matrix (no raw platform text ever)

WebAuthn throws `DOMException` with names like `NotAllowedError` (cancel / timeout) and various platform errors. Map every case to a fixed string:

- Sign-up cancel / dismiss → `"Passkey wasn't created — try again."`
- Sign-up platform error → `"Couldn't create a passkey on this device."`
- Sign-in with no credential → `"That handle may be taken — try a different one."`
- Server-provided error → server message, straight through.

Never surface `.name`, `.message`, or raw `DOMException` text. Users see gibberish; agents see support tickets.

### Session lifetime, revocation, and account deletion

Browser cookie expiry is not server revocation. Cookies can be stolen, devices can be lost, users can want to log everyone out. Ship these before launch:

- **Session TTL.** Every session has a server-side expiry. Even "remember me" sessions cap at some ceiling (30 days / 90 days / a year). Rolling expiry on activity is fine; a session that never expires isn't.
- **Current-session logout.** `POST /api/auth/logout` deletes THIS session token.
- **All-device sign-out.** `POST /api/auth/logout/all` deletes every session token for the current user. Ship a UI affordance in Settings.
- **Passkey management.** List, name, and revoke individual passkeys. If a user loses a device, they need to remove that credential without losing the others.
- **Account deletion.** `DELETE /api/account`. Deletes all sessions, all passkeys, and all account data. If your product retains user-contributed content (games played, messages sent), name the retention policy in the confirmation dialog ("your account will be deleted; games you played remain visible to their other participants with @deleted-user in place of your handle").
- **Data export.** `GET /api/account/export` returns a JSON of everything you have on the user. Required by GDPR / CCPA / basic dignity.

Even a private-only app needs these. Privacy is a product requirement, not a feature.

### No "Passkeys only" footnote

Apple's own dialog explains what a passkey is. The footer explainer is redundant and reads as apology. Delete it.

## Notifications / push

### Policy as principle, not enumeration

State the policy in `docs/requirements-ledger.md`:
> Notifications serve the user's own intention. Re-engagement notifications are banned permanently.

The current set is descriptive, not a cap: e.g. `friend_request`, `challenge`, `challenge_accepted`, `scheduled_start`. Adding a new type means testing against the principle.

### Notification status surface — one surface, not two

Users have permission state (`default` / `granted` / `denied`), subscription state (subscribed / not-subscribed), and installation state (tab vs standalone). These combine into distinct UX states, and each state renders in EXACTLY ONE surface. Never split across "install prompt says X" AND "banner at top of dashboard says Y".

The states:

| State | When it holds | Where it renders |
|---|---|---|
| `unsupported` | No `Notification` / `serviceWorker` / `PushManager` API, OR server didn't provide `pushPublicKey` | Nowhere — the notification affordance is hidden |
| `tab-not-installed` | Supported, running in a browser tab (not standalone), notifications work but the user should install for the full experience | Install prompt (dismissible, in-flow) |
| `standalone-unsubscribed` | Installed, permission `default` or `granted` but no subscription | In-flow "Enable notifications" affordance with reason line |
| `subscribed` | Installed, permission `granted`, subscription present | Nothing visible — this is the working state |
| `denied` | Permission is `denied` | Blocked-recovery copy in place of the enable affordance (see reinstall/settings copy above) |
| `stale-subscription` | Subscription in the SW but not registered on the server (or 410'd) | Silent re-subscribe attempt; fall back to unsubscribed state if it fails |

**One component owns this whole state machine.** Model it as an FSM (see `state-machines.md`), place its representation at ONE place in the shell (typically a strip at the top of the dashboard or a section in a settings page), and never render notification state anywhere else. A banner at the top AND a menu item AND an install prompt all showing overlapping information is the failure mode.

### iOS home-screen PWA has separate subscription state from Safari

**Critical:** an installed PWA (added to Home Screen via Share → Add to Home Screen) has its OWN cookies, its OWN permissions, its OWN push subscription — separate from the Safari tab the user installed it from. A subscription registered in the tab does NOT carry over to the installed PWA.

**Implication:** the "Enable notifications" flow must run again after install. Detect standalone mode and re-check status:
```ts
const isStandalone = window.matchMedia("(display-mode: standalone)").matches
  || (navigator as any).standalone === true;
useEffect(() => { checkPushStatus(); }, [isStandalone, home.pushPublicKey]);
```

### Blocked-notifications recovery on iOS — Settings works, but reinstall is the reliable copy

Once a user taps "Don't Allow" inside the installed PWA, iOS records the block. Recovery paths that exist as of iOS 17+ (per WebKit's own [Web Push for Web Apps on iOS/iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)):

- Settings → Notifications → scroll to find the web app in the app list → toggle Allow Notifications. Works, but the entry only exists once the user has installed the PWA to Home Screen AND the app has requested permission at least once. Non-obvious to non-technical users; also invisible if the PWA was installed under a different name than what iOS labels it in the list.
- Delete the app from Home Screen and add it back. Clears the recorded block; next in-app request re-prompts. Reliably works for every user regardless of technical fluency.

**Ship the reinstall copy as the primary recovery path**, mention Settings as an alternative if you have room. The reinstall path was recommended verbatim by the reference app's owner precisely because Settings hunting is unreliable UX; the invariant is "give users a path they can execute without hunting", not "hide that Settings exists."

**Recovery copy** (drop-in): "Notifications are off. To turn them back on, delete the app from your Home Screen and add it back — you'll be asked again. Or open Settings → Notifications, find this app in the list, and enable Allow Notifications."

### Notification titles are human strings, not template placeholders

Wrong: `"Game challenge from chess"` — this ships when the developer copy-pastes a placeholder.

Right: `"@bob invited you to a game · 10 min"` — specific, actionable.

See `references/copy-discipline.md` for the full rule set on notification copy.

### Dead endpoints cleanup on 410 / 404 — see `durable-objects.md` Rule 7

The push service returns `410 Gone` when a subscription is dead. Remove the endpoint from your DB in the same transaction as the log write. No manual reconciliation, no admin sweep.

## iOS Safari — specific quirks

### Inputs `<16px` auto-zoom

Any `<input>`, `<select>`, or `<textarea>` with computed `font-size < 16px` triggers Safari's auto-zoom on focus. The page zooms in, the user has to pinch-zoom back out, they're annoyed.

**Fix:** `font-size: 16px` minimum on every input/select. Placeholders can be `15px` so they don't look shrunken next to the input text. Never add `<meta name="viewport" content="... maximum-scale=1">` to disable zoom — accessibility regression.

### `svh` / `lvh` / `dvh` — the URL bar viewport units

CSS defines three modern viewport-height variants ([MDN — CSS length units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#dynamic_viewport_units)):

- `100svh` — **small** viewport height (URL bar / toolbar visible, so the smallest usable height the browser will hand you).
- `100lvh` — **large** viewport height (URL bar retracted, the largest usable height). Equivalent to legacy `100vh` in most browsers.
- `100dvh` — **dynamic** viewport height (grows and shrinks as the URL bar retracts/reappears during scroll). Layout re-solves on every change.

Mobile Safari's URL bar + toolbar consume ~120-190px depending on device.

**For a no-scroll surface, prefer `100svh`.** It's a stable value the browser hands you; content sized to it never overflows regardless of URL-bar state. `100dvh` is dynamic — it forces reflow during URL-bar animations and can cause a scroll-lock surface to "grow past" a fixed-position child mid-animation. NEVER use `100vh` alone on mobile — most browsers alias it to `100lvh`, so it overflows when the URL bar is showing (which is most of the time on scroll-locked surfaces).

**For a surface that should USE the extra space when the URL bar retracts:** `100dvh` is the right choice; accept the reflow cost.

Verify in the iOS Simulator, NOT in headless Chromium — headless reports the full nominal height and structurally can't see the URL-bar squeeze.

### Flex intrinsic-min-content on shared parents

When a rule like `.shell > *` styles direct children with `flex: 1` but no `min-width: 0`, iOS Safari falls back to intrinsic-min-content width. Chromium happily overrides; iOS Safari doesn't.

**Fix:** on any shared shell-child rule, include `min-width: 0; width: 100%; align-self: stretch`. Scope surface-specific rules to `body[data-screen="<surface>"]` to prevent leakage.

### `aspect-ratio` ignored when both width and height are set

If you set `width: 100%` AND `height: 100%` AND `aspect-ratio: 1`, iOS Safari picks the explicit dimensions and drops the aspect-ratio. Chromium tries to honor it.

**Fix:** set width OR height, plus `aspect-ratio`. Don't over-constrain.

### `display: grid` with no template = every track is `auto` = compounding solve

`.shell > .stage > .game > .board-column` all as implicit-track grids (`display: grid` with no `grid-template-columns`) makes every track content-derived. Combined with a `width: 100%` + `aspect-ratio: 1` child, iOS Safari re-solves each viewport tick and compounds. Chromium settles it; iOS Safari runs away.

**Fix:** any grid intended to have layout intent gets an explicit `grid-template-columns` (`minmax(0, 1fr)` at minimum). Never rely on implicit tracks for shared parents.

## HTML caching — the Workers Assets trap

Workers Assets serves everything by default with `max-age=0, must-revalidate`. iOS Safari heuristically caches longer than the browser should when there's no explicit `no-cache` directive.

**Fix:** in `wrangler.jsonc`, set `"assets": { "run_worker_first": true, ... }`. Every request enters the worker, which sets explicit cache headers:

```ts
// worker.ts
if (isHtmlLike(url)) {
  res.headers.set("cache-control", "no-cache, must-revalidate");
} else if (isHashedAsset(url)) {
  res.headers.set("cache-control", "public, max-age=31536000, immutable");
}
```

Verify post-deploy:
```bash
curl -sI https://YOURDOMAIN/ | grep -i cache-control
# expect: cache-control: no-cache, must-revalidate

curl -sI https://YOURDOMAIN/manifest.webmanifest | grep -i cache-control
# expect: no-cache

curl -sI https://YOURDOMAIN/sw.js | grep -i cache-control
# expect: no-cache
```

Without this, phones stay on stale bundles for hours after a deploy.

## Origin-aware analytics beacon

If one worker serves multiple canonical domains (`chess.tejas.nyc` and `twochairs.club`), each origin gets its OWN Cloudflare Web Analytics property. Inject the beacon at runtime based on `location.hostname`:

```html
<script>
  (function () {
    var host = location.hostname;
    var token = host === "twochairs.club" || host.endsWith(".twochairs.club")
      ? "PROD_TOKEN_A"
      : "PROD_TOKEN_B";
    var s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token: token }));
    document.head.appendChild(s);
  })();
</script>
```

The beacon script reads `data-cf-beacon` on load, so dynamic injection works. Verify per-origin:
```bash
curl -s https://twochairs.club/ | grep -c 'cloudflareinsights.com/beacon.min.js'
# expect 1
curl -s https://chess.tejas.nyc/ | grep -c 'cloudflareinsights.com/beacon.min.js'
# expect 1
```

**Documented failure mode:** new-tenant builds must include the origin-aware beacon block from source; auto-injecting via a Workers plugin fails silently on Workers-served sites.

## Icons — the iOS Safari quirks

- iOS home-screen icon MUST be PNG. SVG in `<link rel="icon">` is fine for the browser tab, but Safari IGNORES SVG for `apple-touch-icon`.
- Canonical size for `apple-touch-icon.png` is 180×180 (Retina iPhone native pixel density).
- Manifest icons array should include a 512×512 `any maskable` entry for Android adaptive icons.
- Verify: `curl -sI https://YOURDOMAIN/apple-touch-icon.png | grep -i content-type` → `image/png`; `file apple-touch-icon.png` → `PNG image data, 180 x 180`.

## Manifest — the identity split

The `<title>` and manifest `name`/`short_name` play different roles:
- `manifest.name` / `short_name` → the home-screen install label (the wordmark). This is the app's identity.
- `<title>` / `og:title` → describes WHAT the app is (searchable, shareable).

Example:
```jsonc
// manifest.webmanifest
{ "name": "two chairs", "short_name": "two chairs" }
```
```html
<title>chess with friends</title>
<meta property="og:title" content="chess with friends">
```

The URL carries the app's name; the `<title>` should not repeat it. Never let the wordmark leak into the `<title>` or vice-versa. See `references/copy-discipline.md`.

## viewport meta

Always include `viewport-fit=cover` — makes the app aware of iPhone notch / safe-area insets so you can use `env(safe-area-inset-*)` in CSS:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

## theme-color

Set `<meta name="theme-color" content="#7CA898">` matching your surface color. iOS Safari uses it for the URL-bar tint in standalone mode; Android uses it for the address-bar background. Without it the browser picks something ugly.

## Sources

- Reference implementation: `index.html`, `wrangler.jsonc`, `src/worker.ts`, `src/main.tsx` (auth screen + `InstallPrompt` + push status flow), `public/manifest.webmanifest`, `public/sw.js` in the chess-with-friends project.
- The specific fixes above track to commits documented in `docs/requirements-ledger.md` categories "Auth / landing", "Notifications", "Infra" — read those for the exact incident behind each rule.
