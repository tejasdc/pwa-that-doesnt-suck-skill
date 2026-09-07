# {{APP NAME}} — REQUIREMENTS LEDGER (verbatim-spirit)

Every item below was explicitly stated by the product owner. Before ANY major
deploy — and especially the first production build — every item must be
VERIFIED and reported with evidence (screenshot / probe / test name). A
regression on any item is a shipping blocker. Maintained by the team lead;
agents propose additions when new orders are issued.

Categories are structural, not sequential. Order within a category is by
stability (foundational invariants first, tweaks last).

## World / design tokens
- [ ] Palette is exactly: {{ANCHOR TOKENS}}. No {{BANNED TOKENS}}. No legacy tokens.
- [ ] Typography voice: {{DISPLAY FAMILY}} display, {{BODY FAMILY}} body. No serif poems in UI. No thesis-narrating copy anywhere in product UI.
- [ ] No scrolling anywhere scrolling isn't needed (landing, game, {{OTHER NO-SCROLL SURFACES}}).
- [ ] Fixes apply to the PATTERN everywhere — never only the reported page.
- [ ] Attribution / made-by placement: on {{PAGES WITH ATTRIBUTION}} only. Pinned to bottom. Never on {{PAGES WITHOUT}}.

## Auth / landing
- [ ] Single-input auth row: input + button same line, equal heights, shared border. Designed disabled state.
- [ ] Button label morphs via debounced probe: `Sign in as @x` / `Sign up as @x`. Reserved width, no layout jump.
- [ ] No "Passkeys only" footnote. No taken-handle subline. Raw platform error text NEVER surfaces.
- [ ] Error matrix verbatim:
      • sign-up cancel → "Passkey wasn't created — try again."
      • sign-up platform error → "Couldn't create a passkey on this device."
      • sign-in failure → "That handle may be taken — try a different one."
      • server-provided messages pass through.
- [ ] iOS inputs ≥16px computed (no focus zoom).
- [ ] Landing: no scroll at 390, no menu, pinned footer.

## Main surfaces
- [ ] {{PRIMARY SURFACE NAME}} never scrolls: verified at your target device widths (e.g. 390×844, 1280×700, 1440×900) — regression test.
- [ ] {{SURFACE CONTENT RULES}} — e.g. "live content prominent, archived content collapsed"; "action affordances remain active regardless of presence" if presence should not gate actions. Adapt to your app's shape.
- [ ] Human copy everywhere. No machine notation (e.g. "10|0", enum values, mode strings) user-facing.

## Interaction contracts
- [ ] {{ACCEPTED INTERACTION MODEL 1}} — e.g. "tap-tap to move (no drag-and-drop)". If a control model is accepted, later visual work cannot change it without explicit approval — record here so a polish agent cannot silently change the product.
- [ ] {{ACCEPTED INTERACTION MODEL 2}} — e.g. "no toasts during direct manipulation of the domain object; only system failures may toast".

## Notifications
- [ ] Policy is the PRINCIPLE (serves the user's own intention; re-engagement banned permanently). Current set: {{TYPE 1}}, {{TYPE 2}} — descriptive, not a cap.
- [ ] Notification tags are per-entity or per-event, never only per-category — distinct actions from distinct entities never collide in the shade.
- [ ] Blocked-notifications recovery copy: reinstall as the primary path, Settings as fallback (see `references/pwa-specifics.md` for the drop-in copy).

## Auth / accounts
- [ ] Origin strategy decided: canonical rpID scope, duplicate-domain behavior, rename resilience, add-passkey flow, account recovery — all specified before the first passkey ships.
- [ ] Session lifetime, all-device sign-out, account deletion, and data export shipped before launch.

## Infra
- [ ] {{CANONICAL DOMAIN}} canonical; {{ALIAS DOMAIN}} serves duplicate (NO 301 unless explicit).
- [ ] Origin-aware analytics beacon (each domain → its own token).
- [ ] HTML no-cache; hashed assets immutable (deploys reach phones on plain reload).
- [ ] Full test gate green: mechanics + adversity (+ webkit project where runnable).
- [ ] Every deploy verified live: health, beacon, asset hashes, and the specific feature probed on production.

## Process law
- [ ] VISUAL MATRIX SHIP GATE. Before EVERY deploy, run `node scripts/visual-matrix.mjs` and OPEN the contact-sheet HTML for each viewport (390, 430, 1440). Look at every cell. Include the Simulator contact sheet only when optional Safari-focused laptop testing is in scope.
- [ ] HOST-SPECIFIC BROWSER COVERAGE. Follow the global browser policy: Linux Chromium and WebKit at phone and desktop sizes, including short viewports for no-scroll surfaces. Native iPhone Safari is not required. Simulator/browser-chrome checks belong only to optional Safari-focused laptop testing.
- [ ] PROGRAMMATIC OVERLAP GUARD. The `no element overlap` adversity test asserts NO two visible labeled controls (input/select/button/textarea/label) have intersecting bounding boxes at any viewport. Must be green before every deploy.
- [ ] DATA-DEPENDENT STATES ARE MATRIX CELLS. Every state a user can be in must have a matrix cell. Data-dependent states seed the data via the API and screenshot the resulting UI. A state with no cell is a state nobody has ever looked at.
- [ ] Every visual-change agent LOOKS at its own rendered output (screenshots, at the sizes users see, at zoom where detail matters) BEFORE presenting.
- [ ] Every SURFACE carries a layout regression asserting content-column width, offset symmetry, and no-scroll-where-forbidden at 390 and 430. Cross-surface layout leakage becomes a test failure, not a screenshot report.
- [ ] One-owner discipline for layout rules: any rule that shapes a surface must be scoped to `body[data-screen="<surface>"]` unless it is a genuinely shared pattern. Shared shell-child rules must include `min-width: 0; width: 100%; align-self: stretch` on flex children so iOS Safari doesn't fall back to intrinsic-min-content width.

## Adding to the ledger

New requirements are added VERBATIM (spirit, not literal transcription) with:
1. A clear checkbox line stating the invariant.
2. A parenthetical incident pointer if the requirement was born of a specific bug (`(added YYYY-MM-DD after {{INCIDENT DESCRIPTION}})`).
3. If applicable, the evidence pointer (test name or probe command) that proves the requirement is currently met.

## Supersession, never silent contradiction

A ledger with two contradictory lines is worse than a ledger with a wrong line — agents pick whichever appears first in their context and act on it. Ledgers get read literally.

**When an invariant changes:**
1. **Do NOT remove the old line.** Historical record stays; that's how a future agent understands what was tried.
2. **Prefix the old line with `~~SUPERSEDED YYYY-MM-DD~~ →`** and add a pointer to the new line: `~~SUPERSEDED 2026-08-04~~ → see "{{NEW LINE HEADING}}" below`. Struck-through in Markdown reads as visually inactive.
3. **Add the new line in its category** with `(supersedes previous rule from YYYY-MM-DD, reason: {{WHY}})`.
4. **Grep the code and adversity suite for enforcement of the old rule** — remove or update in the same commit as the ledger edit. A ledger update without a code check leaves a fossil.

**Contradictions block ship.** Before every deploy, `grep -c "SUPERSEDED"` and confirm each superseded line has been replaced (not just marked). If a superseded line has no successor, the invariant was killed — say so explicitly (`~~SUPERSEDED 2026-08-04~~ → removed; rule no longer applies because ...`) so future agents don't try to reinstate it.

## Distinguish assertions from enforced code

Every ledger item is one of:
- **Enforced** — a test, hook, or lint rule fails when the invariant is violated. Cite the test name or file:line.
- **Verified** — a manual probe (screenshot, curl, eyeball) confirms the current state matches. Cite the probe command or screenshot.
- **Aspirational** — the invariant exists on paper but nothing prevents violation. Mark `[aspirational]` so nobody reads it as guaranteed.

Enforced beats verified beats aspirational. Aspirational items should have a follow-up task to make them at least verified.
