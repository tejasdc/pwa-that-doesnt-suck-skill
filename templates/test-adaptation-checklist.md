# Template adaptation checklist

*The templates in this directory are STARTERS with placeholder scaffolding and fail-loud TODO markers. A fresh app that copies them without adapting will have a red test suite from the first run. That is on purpose — a passing test that tests nothing is worse than no test.*

Work through this checklist the first time you copy the templates into a new project. Every unchecked item is either "you have not adapted it yet" (fix now) or "your app genuinely doesn't need this" (delete the block with a one-line comment explaining why).

## `templates/adversity.spec.ts`

- [ ] Replace `twoClientsInSession()` with your app's real two-client bootstrap. What "in session" means is app-specific (in a shared game, in a shared document, in a shared chat).
- [ ] `socket death mid-session recovers silently` — replace the `throw new Error(...)` with a real assertion that verifies the missed event appears on the recovered client. Cite what "the event" is for your app.
- [ ] `visibilitychange after socket death triggers immediate resync` — same. Assert the resync fires within a bounded time after visibility flips back.
- [ ] `network dropout` — emit the event from client A while B is offline; assert B sees it after network + visibility.
- [ ] `rapid double-tap` — replace `/api/{{ACTION_ENDPOINT}}` placeholder with the real endpoint. Assert exactly one POST reaches the server.
- [ ] `action roundtrip stays under the perf budget` — replace the "TODO: emit action" comment with your app's primary action (send message, submit form, etc.). Pick a budget appropriate to your app; 2000ms is a generic default for a snappy synchronous action.
- [ ] `invitation lifecycle: withdraw path` — replace with your primary lifecycle's withdraw / decline / cancel scenario. Cite the transitions from your `docs/state-machines.md`.
- [ ] `primary surface never scrolls` — assert `body[data-screen]` matches your app's actual surface name; update the viewports to include your app's target device widths.
- [ ] `no element overlap` — implement the overlap walk by importing `CELLS` and `collectOverlaps` from `scripts/visual-matrix.mjs` (once you have adapted that file). See `verification-stack.md` for the pattern.

Every scenario that doesn't apply to your app: DELETE it (do not leave the throwing placeholder in place) and write a one-line comment `// N/A: {{reason}}` where the test was.

## `templates/visual-matrix.mjs`

- [ ] Preflight URL matches your app (`http://localhost:8787` for wrangler dev; different for other stacks).
- [ ] `register()` selectors match your actual auth flow — placeholder text `"your_handle"` and the morphing button label pattern are the reference app's shape; yours may differ.
- [ ] `makeContext()` establishes the relationship between test users the way your app does. The comment `TODO: fill in the specific handshake` is a real TODO.
- [ ] Every `ensure*(ctx)` helper hits your app's actual API paths, not the reference `/api/invitations` placeholder.
- [ ] Every CELL in the CELLS array corresponds to a state described in `docs/state-machines.md` — including data-dependent cells. If a state exists in the doc but has no cell, add one.
- [ ] Delete the reference cells for lifecycles your app doesn't have (invitations, friendships) and replace with your app's actual lifecycles.
- [ ] Each cell declares `seed(ctx)` and `cleanup(ctx)` — the reference file has ordered cell arrays that clean up implicitly by ordering; if your app has independent data states, prefer explicit seed/cleanup contracts (see the "matrix state isolation" section of `verification-stack.md`).
- [ ] Leave `SIMULATOR_UDIDS` empty for normal Linux verification. Populate it only for optional Safari-focused laptop testing with installed Xcode; find the laptop's UDID with `xcrun simctl list devices | grep 'iPhone'`.

## `templates/requirements-ledger.md`

- [ ] Every `{{PLACEHOLDER}}` filled in with your app's actual values (palette hex codes, typography families, canonical domain, attribution copy).
- [ ] Categories genericized or replaced with your app's actual surfaces. The reference file has "Main surfaces (dashboard / game / etc.)" — replace with your surface names.
- [ ] Every ledger item has an evidence pointer — a test name (`tests/adversity.spec.ts:{{TEST_NAME}}`) or a screenshot path or a probe command. If a ledger item has no evidence pointer, it's a wish, not an invariant.
- [ ] Notification policy stated as PRINCIPLE (not enumeration) — see `references/copy-discipline.md` and `references/pwa-specifics.md`.
- [ ] Interaction contracts recorded — if you have committed to tap-to-move (not drag-and-drop), that goes in the ledger. If you have committed to no-toasts-during-play, that goes in the ledger. Otherwise a polish agent will silently change it.

## `templates/state-machines.md`

- [ ] Vocabulary section retained (it is the shared language every reader needs).
- [ ] "Sources of truth" table reflects your actual DO / service topology.
- [ ] Machine inventory names your real machines. Delete the reference stubs (Session, Relationship, Invitation, Schedule, Primary Domain Object, Connection, Push) that don't apply.
- [ ] Every machine has: purpose, states, events, transitions (mermaid), writer, representation, closure, notes.
- [ ] Every machine has AT LEAST ONE GAP-N entry OR an explicit "no known gaps" note. Silence means "the author hasn't looked yet."

## `templates/wrangler.jsonc`

- [ ] `compatibility_date` bumped to the current tested date (whatever `wrangler dev` was working against when you built the project). Do NOT copy the reference date and forget about it.
- [ ] `APP_NAME` set to your identity.
- [ ] `VAPID_PUBLIC_KEY` generated via `node scripts/generate-vapid.mjs` (or equivalent) and pasted. Private key is a `wrangler secret`, NEVER in this file.
- [ ] DO class names match your actual class names (`AppDO`, `EntityDO` are reference names).
- [ ] `new_sqlite_classes` includes every DO class from the first migration.
- [ ] `run_worker_first: true` retained if you want HTML no-cache headers via the worker (the standard case). Only remove it if your app is fully static.

## `templates/index.html`

- [ ] `<title>` says what the app IS (not the wordmark — see the copy-discipline "identity split" section).
- [ ] All `{{PLACEHOLDER}}` tokens filled in.
- [ ] `<meta name="theme-color">` matches your primary surface color, not the default.
- [ ] Origin-aware beacon block updated with your actual Cloudflare Web Analytics site tokens for each canonical domain (or the whole `<script>` block deleted if you're not using CF analytics).
- [ ] Font `<link>` matches whatever family your CSS actually loads (the reference uses IBM Plex; yours may differ).

## When you are done

Every checkbox is either checked or deleted-with-reason. The suite runs green because the assertions are real, not because placeholders were left in place. The visual matrix opens contact sheets you can look at. The ledger has evidence pointers you can grep for.

At that point — and not before — the templates have graduated from starter to shipping.
