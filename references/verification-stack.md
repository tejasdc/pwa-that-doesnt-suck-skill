# Verification stack

*Load before writing tests, running a matrix, or shipping. Select the layers that match the execution host and approved acceptance scope; the optional laptop Simulator layer is not a Linux shipping gate.*

The global host-specific browser policy is authoritative. On Linux, use `browser-verification` for Chromium and WebKit at mobile and desktop sizes. Native iPhone Safari is not required. The Simulator recipe below is only for optional Safari-focused work on the laptop. Source: Tejas's 2026-09-07 policy clarification after Linux agents repeatedly treated unavailable Apple tools as incomplete verification.

For keyboard-following controls, use the [viewport geometry regression guidance](pwa-specifics.md#keyboard-following-controls-use-one-coordinate-system). A viewport mock must cover the metric relationship that failed; a phone-sized screenshot does not exercise native keyboard behavior.

## The stack (top of pyramid to bottom)

Each layer catches a class of bug the layer below cannot see. Run them in order.

| Layer | Catches | When to run |
|---|---|---|
| 1. Typecheck + build | Import breaks, TS-visible type mismatch | Every edit (`tsc --noEmit && vite build`) |
| 2. Push-policy verifier | Notification/UX rules encoded in code (e.g. "no re-engagement pushes ever") | Pre-commit |
| 3. Adversity suite | Lifecycle transitions under hostile conditions — dead sockets, hidden tabs, network dropout, throttled CPU, rapid double-tap, no-scroll invariants | Pre-commit + CI |
| 4. Visual matrix (headless) | Every surface × every state × every viewport as PNG. Data-seeded so states that only exist with data still get captured. Overlap guard in the same pass. | Pre-deploy |
| 5. Optional laptop iOS Simulator matrix | Safari browser chrome and OS-dependent viewport behavior | Only for Safari-focused laptop testing in scope |
| 6. Contact-sheet human eyeball | Anything the machine can render but not judge — hierarchy, weight, rhythm, copy at zoom | Pre-deploy, MANDATORY |
| 7. Requirements ledger review | Regressions on stated invariants ("must not scroll on iPhone", "no toast during gameplay") | Pre-deploy |
| 8. Live-production probe | Post-deploy: `/api/health`, asset hashes served, beacon count, the specific feature exercised on production URL | Immediately after deploy |

## Why the ladder exists — the founding incidents

Each layer was added because something below it failed in a way the layer above catches:

- Layer 4 (matrix) was added after a schedule form shipped with the Time field crushed under the Repeat dropdown at desktop widths. Nobody had opened the desktop schedule dialog. Rule: **a state that requires data to exist must still have a UI treatment for the data-present case tested.**
- Layer 5 (simulator) originated in a laptop investigation of an inspirations page that overflowed with Safari's browser chrome present. It remains useful for that specific acceptance scope. On Linux, verify no-scroll requirements at representative and short viewports in Chromium and WebKit; do not turn the historical Simulator recipe into a native-device prerequisite.
- The overlap guard was added after the same schedule-form incident. It walks the same surfaces and asserts NO two visible labeled controls (input/select/button/textarea/label) have intersecting bounding boxes at any viewport. Catches states nobody thought to eyeball.
- The **data-seeded matrix cells** rule was added after a `WaitingRow` shipped mangled ("Waiting for @raz" wrapped into three centered lines with the arrow orphaned and Withdraw marooned mid-row) because the matrix covered UI states like disclosure/menu open but no cell existed for the DATA state "dashboard with pending outgoing challenge". Rule: **the matrix seeds the data the state needs, then screenshots the result. A state with no cell is a state nobody has ever looked at.**

## Requirements ledger — the shipping gate

**Every stated invariant is recorded verbatim in `docs/requirements-ledger.md` with an evidence pointer** (test name, screenshot, probe). Before every major deploy — especially any deploy touching a surface the invariant covers — every item is verified. A regression on any item is a shipping blocker.

Categories to structure by:
- World / design tokens (palette, typography, spacing invariants)
- Per-surface constraints (landing, dashboard, game, settings)
- Auth / onboarding
- Notifications policy
- Infra (canonical domain, beacon, cache headers, deploy verifications)
- Process law (the meta-rules — matrix ship gate, host-specific browser scope, overlap guard, look-at-your-own-screenshots)

See `templates/requirements-ledger.md` for the drop-in shape.

## Visual matrix — the data-seeded machinery

Load `templates/visual-matrix.mjs`. Structure:

- **Preflight** — asserts `wrangler dev` is reachable at `:8787`. Errors with the exact command to run if not.
- **Virtual WebAuthn** per browser context via CDP (`WebAuthn.enable` + `WebAuthn.addVirtualAuthenticator`) so passkey flows work headlessly.
- **Multiple test users per viewport** — alice + bob + charlie + zero-friends, each in their own browser context. Real relationships (alice ↔ bob friends), so cells like "incoming challenge on bob's dashboard" are reachable.
- **Data-seeded cells** — the runner has helpers like `ensureOutgoingChallenge(ctx)` that call the API directly to create the data state a cell needs (`POST /api/challenges`), then screenshot the resulting UI. Cells with conflicting data (rest vs outgoing-challenge) are ordered so cleanup runs between them.
- **Cell POV escape hatch** — a cell function can return an alternate `Page` when the state naturally lives on someone else's page (incoming challenge on bob, zero-friends on the empty user). The runner screenshots the returned page instead of the default.
- **Overlap collector** — after each screenshot, `page.evaluate` walks all `input/select/button/textarea/label`, filters ancestor-of-other pairs and modal-vs-page pairs, and reports any AABB intersection ≥ 3px in both dimensions.
- **HTML contact sheet per viewport** — labeled mosaic loading the shots, three-color status (ok / warn / fail) based on overlap count.
- **Optional laptop iOS Simulator pass** — enabled only on macOS with configured UDIDs for Safari-focused testing. For URL-reachable states only (landing, inspirations, marketing pages). Uses `xcrun simctl boot <UDID>`, `xcrun simctl openurl <UDID> <url>`, `xcrun simctl io <UDID> screenshot`. Contact sheet is a separate HTML.

Cells to include AT MINIMUM for a friends-driven PWA:
- Unauth: landing / rest, landing / interactive-selected, landing / mid-transition, marketing sub-pages.
- Dashboard: rest, add-friend open, schedule open, menu open, menu / notif-info open.
- Data states: dashboard / outgoing challenge, waiting room, other user's dashboard / incoming challenge, dashboard / live game, dashboard / accepted schedule, dashboard / incoming friend request, dashboard / outgoing friend request, dashboard / zero friends.
- Game: live, selected, terminal.

## Adversity suite — proves invariants under hostile conditions

Load `templates/adversity.spec.ts`. Serial mode inside the file (`test.describe.configure({ mode: "serial" })`) because a memory-constrained laptop can't run parallel browser contexts.

Scenario categories:
- **Socket death** — inject a WebSocket wrapper via `addInitScript` that pushes each socket onto `window.__sockets`; `killAllSockets(page)` force-closes them. Assert the game recovers silently — opponent's move materializes after reconnect.
- **visibilitychange after socket death** — the iOS "backgrounded, socket died silently" state. Kill sockets, flip `visibilityState` to hidden, make a move on the other side, flip back to visible. Assert immediate resync.
- **Full network dropout** — CDP `Network.emulateNetworkConditions { offline: true }`. Make a move on the other side, restore network, dispatch visibilitychange. Assert missed move materializes within a generous timeout.
- **Rapid double-tap** — simulate mobile-user reflex; assert exactly one move goes to the server (network response listener + turn assertion).
- **Perf budget on throttled CPU** — CDP `Emulation.setCPUThrottlingRate { rate: 4 }`; assert move roundtrip stays under a budget (e.g. 2000ms). Catches "incredibly bad lag" 10x regressions.
- **Lifecycle transition coverage** — for every state machine, one test per transition. Specifically the withdraw / decline / expire paths, not just accept.
- **Layout regressions per surface** — assert content-column width, offset symmetry, and no-scroll-where-forbidden at 390 and 430. Added because a landing-scoped CSS change silently narrowed the dashboard column on iOS Safari.

## The no-scroll regression

If any surface is contractually no-scroll (landing, game, inspirations), add:
```ts
const scroll = await page.evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight,
  innerHeight: window.innerHeight,
}));
expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.innerHeight + 1);
```
Run at 390×844, 1280×700, 1440×900 minimum. The 1280×700 case (short-vertical laptop) is the one people forget.

## Time-warp harness for alarm-driven behavior

Any lifecycle whose transitions fire on a Cloudflare alarm (schedule expiry, grace timers, cleanup sweeps) needs an in-process time-warp endpoint. **Never trust "correct by code review" for lifecycles that fire on a timer.**

Pattern (from the reference project):
- Local-only route `POST /_debug/tick` guarded by `x-debug-local: true` header, only wired up when `env.APP_ENV !== 'production'` (or a debug flag).
- Body `{ now: number }`. The handler shifts due timestamps into the past, then invokes `alarm()` directly on the DO.
- Adversity test uses it: create the state, tick past the due time, assert the transition fired.

For a recurring schedule (weekly / daily): the test creates the schedule with `nextFireAt` a week in the past, ticks once, asserts (a) exactly one new game was created, (b) `nextFireAt` advanced by exactly one interval, (c) new `nextFireAt` is strictly in the future. Catches both double-fire and never-advance regressions.

## Optional laptop Simulator recipe

Use only when Safari-focused laptop testing is in scope. Requirements: macOS, Xcode installed, an iOS Simulator device booted (or bootable) with a stable UDID. Leave `SIMULATOR_UDIDS` empty otherwise; Linux verification does not use this recipe.

```bash
# Find the UDID once and pin it in a constant.
xcrun simctl list devices | grep 'iPhone 17 Pro'
# → iPhone 17 Pro (3C3CF59F-CC82-47B0-A139-0F14D6AF6165) (Booted)

# In the matrix script:
const SIMULATOR_UDIDS = [
  "3C3CF59F-CC82-47B0-A139-0F14D6AF6165", // iPhone 17 Pro
];

# Boot idempotently (errors if already booted; swallow it):
try { await execFileP("xcrun", ["simctl", "boot", udid]); } catch { /* booted */ }
await sleep(800); // let it settle after fresh boot

for (const st of URL_STATES) {
  await execFileP("xcrun", ["simctl", "openurl", udid, url]);
  await sleep(3500); // Safari load + first-paint measure
  await execFileP("xcrun", ["simctl", "io", udid, "screenshot", pngPath]);
}
```

**First-run popup dismissal** — the very first `simctl openurl` on a fresh Simulator may show a "Would you like to allow…" dialog. Dismiss it manually once with `xcrun simctl ui <UDID> …` or the GUI; the matrix pass assumes a warm Simulator.

**Only URL-reachable states go to this Simulator recipe.** Deep interactive states (menu open, form open, mid-transition) stay in the scripted browser matrix. The optional laptop pass captures landing / marketing / auth surfaces where Safari browser chrome is the subject of the check.

## Selector / API drift audit — kill fossil tests after every UX rewrite

A test suite that still targets removed controls is worse than no suite: agents learn to discount CI ("that's just the old tests failing"), the fossils rot, and real regressions land in a suite that's already amber.

**After every UX rewrite:**

1. Run the full suite. Any test that fails because of a removed selector, a renamed button, a removed endpoint, or a changed placeholder — REWRITE OR DELETE in the same PR as the UX change.
2. Grep the suite for the OLD names to find the fossils:
   ```bash
   grep -rE "getByRole.*old-button-name|/api/removed-endpoint|placeholder.*old-text" tests/
   ```
3. Every fossil either gets rewritten against the new UX in the same PR, or gets deleted with a one-line comment `// removed: {{feature}} no longer exists ({{PR#}})`.
4. Never merge a UX rewrite that leaves the suite red on fossil failures. The rule is: after the rewrite, the suite is green because the tests match the current product, not because someone `test.skip`'d the failures.

The reference project shipped an e2e suite that still targeted removed schedule controls after a UX rewrite; the failures were dismissed as "known" and the suite lost credibility.

## Semantic visual annotations — assert data, not pixels

For every UI annotation derived from domain state (last-move highlight, check indicator, winner banner, presence dot, "you have unread" badge), the test asserts against the underlying data attribute (or the domain truth source), NOT only against pixel presence. See `references/state-machines.md` rule 11 for the pattern; the specific test shape:

```ts
test("last move highlight covers exactly the from and to squares", async ({ page }) => {
  await move(page, "e2", "e4");
  // Pull the actual highlighted squares from the DOM, not from pixel diffing.
  const highlighted = await page.locator("[data-last-move]").evaluateAll(
    els => els.map(e => e.getAttribute("data-square")).sort()
  );
  expect(highlighted).toEqual(["e2", "e4"]);

  // And nothing else has the highlight:
  const all = await page.locator("[data-last-move]").count();
  expect(all).toBe(2);
});
```

Rules of thumb:
- If your annotation has a discrete "on/off" per element, add a `data-*` attribute for each state and assert against it.
- If the annotation is a range/value (a bar length, a color intensity), assert the computed value via `getComputedStyle` OR the domain-source value that drives it.
- Snapshot / pixel tests are a supplement, not a substitute. Pixel tests catch "did it render at all"; data-attribute tests catch "did it render the RIGHT thing."

## The "look at your own screenshots" rule

Every visual-change agent LOOKS at its rendered output — screenshots, at the sizes users see, at zoom where detail matters — BEFORE presenting. Evidence assembled without being looked at is the named failure mode.

For an agent, "look" means: `Read` the PNG file with the file-reading tool (which renders the image inline) at the actual pixel size, zoom the browser to the target viewport, or open the contact sheet in `mcp__claude-in-chrome__computer` and screenshot it back. If you're presenting design work, side-by-side the render against the reference at the same zoom.

## Post-deploy verification

Immediately after every deploy:
```bash
curl -s https://YOURDOMAIN/api/health         # expect 200 + {"ok":true}
curl -s https://YOURDOMAIN/ | grep -oE 'index-[A-Za-z0-9]+\.js'   # asset hashes changed
curl -s https://YOURDOMAIN/ | grep -c 'cloudflareinsights.com/beacon.min.js'  # expect 1
curl -sI https://YOURDOMAIN/ | grep -i cache-control              # expect no-cache
```
Plus a probe of whatever specific feature the deploy touched — a POST to the endpoint that changed, a page-render check, an asset-served-with-right-mime probe. Every deploy verifies live; a green CI is not evidence the deploy worked.

## Sources

- `scripts/visual-matrix.mjs` (reference implementation, ~680 lines) — the walked example.
- `tests/adversity.spec.ts` (reference implementation, ~1500 lines) — the scenario catalog.
- `docs/requirements-ledger.md` (reference implementation) — the ledger shape.
