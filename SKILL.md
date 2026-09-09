---
name: pwa-that-doesnt-suck
description: Build, ship, or debug an installable PWA, especially Cloudflare Workers and Durable Objects applications with stateful interactions, passkeys, push, offline use, or iPhone WebKit behavior. Covers native lifecycle ownership, draft-safe updates, isolated browser and device verification, and observable UI states. Use alongside a design skill for visual design. Not for static pages, purely native apps, or standalone component polish.
---

# PWA That Doesn't Suck

The default LLM output for "build me a PWA" is a demo that looks fine in headless Chromium, breaks on the first real iOS Safari phone, has copy that reads like a designer explaining a joke, ships with a lifecycle nobody drew (`pending` states with no exit, notifications that block with no recovery, invitations the sender cannot withdraw), and passes CI while shipping broken layouts to the user. This skill is the accumulated fix for that. Read this file to know what invariants exist and where the details live; open the reference file when you're about to do the thing.

## The ten invariants

Each one has a full reference file; the invariant here is the load-bearing sentence.

1. **If it has a lifecycle, model it before you write it.** Every entity whose meaning depends on when you look at it (invitation, friendship, game, schedule, subscription, connection) carries a state machine. States are named, transitions have guards, one writer owns mutation, every state has a UI representation on every surface where the entity is user-relevant, and every state has an exit. Scattered booleans are how you get "the invite still says `Invite`" bug. See `references/state-machines.md`.
2. **Verification follows the host and the approved scope.** Programmatic tests, a data-seeded visual matrix, an overlap guard, and a requirements ledger cover mechanics and representations. Use `browser-verification` for Chromium/WebKit coverage on Linux. Native iPhone Safari is not a Linux shipping gate; iOS Simulator is an optional laptop layer for Safari-focused testing. See `references/verification-stack.md`.
3. **Copy is declarative and plain.** No em-dash chains, no capitalized "X is Y" declarations, no "not just X, it's Y", no designer-explaining-the-joke thesis narration in product UI. The product embodies its thesis; it never explains it. Read every string aloud before shipping. See `references/copy-discipline.md`.
4. **Feedback lives at the locus of action, ranked by severity.** During direct manipulation of a domain object, the object itself is the only feedback channel — no toasts. Toasts are for system failures; inline status is for successful state changes; disabled/hidden controls prevent illegal actions before they happen; OS notifications are for events the user is not looking at. See `references/interaction-feedback.md`.
5. **Cloudflare Durable Objects hibernate AND awaiting external fetch opens the input gate.** State that lives only in RAM evaporates on hibernation; state that gets mutated before the storage write can race a concurrent request that entered during your `await`. Persist durable intent BEFORE external side effects. No `setTimeout` for lifecycle timers — use `ctx.storage.setAlarm`. No `Map<WebSocket, meta>` for connection tracking — use `ctx.acceptWebSocket()` + `serializeAttachment()`. Cleanup sweeps run on BOTH allocation and completion paths. Recurrence stores civil-time fields, not fixed milliseconds. See `references/durable-objects.md`.
6. **A PWA is not a web page. It's an installable object with per-origin secrets AND per-installation delivery infrastructure.** Passkey `rpID` scopes to registrable-domain suffix (decide before first passkey); `rpName` comes from server env. Notification policy is a PRINCIPLE ("serves user's own intention; re-engagement banned"), not an enumeration. iOS home-screen PWA has separate cookies / subscription / permissions from Safari tab. Blocked notifications recover via delete-and-reinstall as the primary path (Settings works as fallback). iOS inputs `<16px` auto-zoom. HTML must be `no-cache`; hashed assets `immutable`. Analytics beacons are origin-aware. Service worker `push` handler awaits `showNotification` before ack, uses per-entity tags, and cleans up old caches on activation. See `references/pwa-specifics.md` and `references/push-delivery-and-service-worker.md`.
7. **React and imperative animation never share DOM nodes; effects that POST never depend on unstable callbacks.** Animation code that mutates DOM directly lives inside an opaque ref'd container React never enumerates. Otherwise React tries to unmount detached nodes → `removeChild NotFoundError` → whole surface crashes on the third round. Belt-and-suspenders with an error boundary that resets by bumping a `key`. `useEffect(() => POST, [callback])` where the callback is recreated on every parent render is a silent request loop; depend on stable primitives. See `references/react-imperative-animation.md`.
8. **Accessibility is a state contract, not a polish pass.** Every interactive visual state has a keyboard operation, a focus movement, an ARIA state, and screen-reader copy specified alongside the visual representation. Focus never disappears silently; modals trap and return; live regions announce state changes. See `references/accessibility.md`.
9. **Agent orchestration is deterministic and observable.** Codex sessions are dispatched with explicit UUID resume (never `--last`), goals-only prompts (never prescribed implementation), tee-captured logs, and monitor wakeups armed by the dispatcher — task-notifications alone drop silently. Multiple concurrent agents get one-owner-per-path stand-down rules. See `references/agent-orchestration.md`.
10. **If the app has visible product design work, load a design skill alongside this one.** This skill teaches the discipline that lets taste survive contact with real devices; it does not teach taste. A fresh agent using only this skill will ship a stable, correct, ugly app. Load `impeccable` or `frontend-design` for the design work; keep this skill loaded for the shape.

## Setup

Before writing any code:

1. **Draft `docs/requirements.md` and `docs/requirements-ledger.md`.** The requirements doc is discussion. The ledger is the shipping gate — every stated invariant recorded verbatim with an evidence pointer, verified with screenshot / probe / test name before every deploy. Copy `templates/requirements-ledger.md`.
2. **Draft `docs/state-machines.md` before any lifecycle code.** Copy `templates/state-machines.md`. Names every machine, its states, transitions, guards, single writer, projections, closure, and cardinality budgets for bootstrap payloads. A PR that adds a lifecycle without landing this file in the same change is incomplete.
3. **Decide origin strategy and account model.** Canonical auth origin, duplicate-domain behavior, rename resilience, add-passkey flow, account recovery — record in the ledger BEFORE the first passkey ships. See `references/pwa-specifics.md`.
4. **Scaffold `wrangler.jsonc` with hibernation-safe DO bindings and no-cache HTML.** Copy `templates/wrangler.jsonc`. Set `compatibility_date` to today's tested date, not the template's placeholder.
5. **Scaffold `index.html`** with the origin-aware beacon, PWA manifest link, `apple-touch-icon`, and `viewport-fit=cover`. Copy `templates/index.html`. iOS home-screen icons are PNG.
6. **Scaffold `scripts/visual-matrix.mjs` and `tests/adversity.spec.ts`.** Copy the templates. Both ship with fail-loud placeholders; work through `templates/test-adaptation-checklist.md` before considering them functional. A green suite that tests nothing is worse than no suite.
7. **If UI design quality is part of the job**, also invoke `impeccable` / `frontend-design` alongside this skill.

## Working rhythm (per feature)

For every new feature or fix:

1. **Name the lifecycle.** States, events, transitions, guards, writer, representations, closure, keyboard/ARIA. Land it in `docs/state-machines.md`.
2. **Ledger the requirement** if the user stated it. Every stated invariant becomes a permanent line with an evidence pointer.
3. **Implement the writer.** Single mutation site, idempotent, guarded. Persist durable intent BEFORE external side effects; use `ctx.waitUntil()` with retry for the side effects.
4. **Project on every surface.** Every state that is user-relevant renders on every screen the entity lives on. Every event path reconciles every projection column (storage / broadcast / push / alarm / cross-DO).
5. **Add a matrix cell.** If the state needs data to exist (pending challenge, live game, incoming friend request, zero-friends empty state), declare `seed` / `cleanup` / `expected` on the cell.
6. **Add adversity coverage.** Every transition — including withdraw / decline / expire — has a test. Every P0 constraint (no scroll, silent-board-during-play, socket-death-recovers) has a regression test. Every semantic visual annotation asserts against a domain-truth `data-*` attribute, not only pixels.
7. **Run the full visual matrix and OPEN THE CONTACT SHEET.** Look at every cell at zoom. When optional laptop Safari testing is in scope, also inspect its Simulator sheet. Overlap guard must be green.
8. **Scrub the copy.** Read every string aloud. Kill any tell from `references/copy-discipline.md`.
9. **Deploy and verify live.** Health probe, beacon count, asset hashes, `no-cache` header check, and a probe of the specific feature the deploy touched.
10. **Audit for fossil tests.** After any UX rewrite, grep the suite for old selectors / removed endpoints. Rewrite or delete in the same PR.

## Reference index

Load on demand:

| File | When to open |
|---|---|
| `references/state-machines.md` | Adding any lifecycle, status field, or boolean-flag pair. Contains 11 rules, per-feature checklist, anti-patterns, four "good-looks" patterns, presence-is-projection rule, reconcile-per-entry-path table, semantic-annotation assertion. |
| `references/verification-stack.md` | Writing tests, running the matrix, or shipping. Contains the ship-gate ladder, simulator recipe with UDID, time-warp harness, fossil-test audit, semantic-annotation test shape. |
| `references/copy-discipline.md` | Writing any user-facing string. AI-slop tell catalogue + read-aloud test + rewrite pattern + error matrix + notification titles + `<title>` vs wordmark split. |
| `references/interaction-feedback.md` | Adding any toast, banner, alert, or "you can't do that" message. Five-channel taxonomy (prevented / silent no-op / inline status / toast / OS notification). |
| `references/agent-orchestration.md` | Dispatching Codex or a subagent, or running multiple agents on the same repo. Codex CLI resume by UUID, goals-only prompts, one-owner-per-path stand-down, parent-rest trap, monitor-wakeup pattern. |
| `references/durable-objects.md` | Writing any DO or touching WebSocket / alarm / storage code. Input-gate + await, persist-intent-before-side-effect, hibernatable sockets, derived-not-stored connection state, cross-DO retry, alarm rearming, hot/cold classification, civil-time recurrence, bootstrap payload budgets. |
| `references/pwa-specifics.md` | Touching manifest, service worker, passkey / WebAuthn, push permission, HTML head, iOS-specific styles, or origin-aware beacons. For keyboard-following toolbars/composers, read [keyboard viewport geometry](references/pwa-specifics.md#keyboard-following-controls-use-one-coordinate-system). Also covers persistent cookies, quit/reopen tests, origin strategy, session lifetime / revocation / deletion, notification-status surface. |
| `references/push-delivery-and-service-worker.md` | Writing the `push` event handler or notification tag scheme. `showNotification` awaiting, GET-safety, per-entity tags, outbox pattern, activation cache cleanup, click routing, subscribe-after-standalone. |
| `references/react-imperative-animation.md` | Writing animation code that mutates DOM directly, or any effect that POSTs. Ownership isolation pattern + error boundary + command-effect stable-dep rule. |
| `references/accessibility.md` | Shipping any interactive component. Four-column spec (role / keyboard / focus / SR state), common widget patterns, keyboard-only walkthrough gate. |

## Template index

Drop-in starters — copy the file, then work through `templates/test-adaptation-checklist.md`.

| File | What it is |
|---|---|
| `templates/requirements-ledger.md` | The shipping-gate ledger. Categories, evidence-pointer format, supersession rule. |
| `templates/state-machines.md` | The lifecycle audit doc. Vocabulary, sources of truth, machine inventory, per-machine template. |
| `templates/visual-matrix.mjs` | Playwright + virtual WebAuthn + data-seeded cells (with seed/cleanup/expected contract) + overlap collector + HTML contact sheet + iOS Simulator pass. Requires `wrangler dev` on `:8787`. |
| `templates/adversity.spec.ts` | Skeleton scenarios that FAIL LOUD until adapted: socket death, visibilitychange resync, network dropout, rapid double-tap, throttled CPU perf budget, invitation lifecycle, no-scroll regression, overlap walk. |
| `templates/wrangler.jsonc` | Hibernation-safe DO bindings, `run_worker_first: true` for HTML no-cache override, SQLite migration, VAPID + APP_NAME vars. `compatibility_date` placeholder — set to your tested date. |
| `templates/index.html` | PWA head: manifest, `apple-touch-icon`, `viewport-fit=cover`, `theme-color`, origin-aware analytics beacon, `<title>` vs wordmark split. |
| `templates/test-adaptation-checklist.md` | Walk this before considering the templates functional. Every placeholder is either adapted or deleted-with-reason. |

## Anti-triggers — do NOT use this skill for

- A static marketing page with no server state → use `frontend-design` / `impeccable` / `high-end-visual-design`.
- A pure native mobile app (Swift/Kotlin) → use platform skills.
- A component-library polish task on an existing shipped PWA → use `impeccable` for the design work; only load this skill's `state-machines.md` if you're adding a lifecycle.
- A "chatbot in a webpage" without lifecycles → this skill's weight is overhead you don't need.

## What this skill deliberately does NOT teach

- Framework choice. React, Preact, Solid, Svelte, plain TS — the invariants apply to all. Templates assume React because the source app was React; adapt the ownership pattern to your framework's escape hatch (`v-html`, `bind:this`, etc.).
- Design taste. Load `impeccable` / `frontend-design` / `emil-design-eng` for that. Invariant #10 makes the handoff explicit; this skill covers the shape, not the taste.
- Business logic and domain data. Chess rules, chat protocols, payment logic, real puzzles vs invented ones — the skill teaches the shape state should take, not the state you should have. **If your product depends on real-world or game rules, prove fixtures and animations against the domain engine** — invented data and invalid transitions are product-breaking; this remains outside the skill's scope, but the requirement is real.
- Content design. Attribution, source-image selection, editorial voice — copy discipline removes slop but does not build evidence-backed content. Load a content / editorial skill.
