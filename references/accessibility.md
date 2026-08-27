# Accessibility as a state contract

*Load before shipping any interactive component. Accessibility is not a polish pass; it's a state contract. If the visual state machine isn't exposed semantically, keyboard and screen-reader users can't operate the app, and headless automation misses real user flows.*

## The rule

**For every interactive visual state, define keyboard operation, focus movement, ARIA state, and screen-reader copy as part of the component spec — in `docs/state-machines.md`, alongside the visual representation.**

If your state machine names `pending` / `accepted` / `withdrawn` and specifies the visual representation ("ghost `Invited` button that opens the waiting room"), it also specifies the semantic representation ("button, `aria-label=\"Invited @bob\"`, `aria-pressed=\"true\"`; Enter/Space opens the waiting room; focus moves to the waiting-room heading on navigation").

## The four columns

Every interactive component's spec has four columns filled in:

| Column | What goes here |
|---|---|
| **Role** | `button`, `link`, `checkbox`, `dialog`, `alert`, `list` / `listitem`, `grid` / `gridcell`, `option`. Use native elements first; ARIA roles second. |
| **Keyboard operation** | Enter / Space / Escape / arrow keys / Home / End behaviors. Every mouse gesture has a keyboard equivalent. |
| **Focus movement** | Where focus goes on activation, on state change, on modal open/close, on route change. Focus never disappears silently. |
| **Screen-reader state** | `aria-expanded`, `aria-pressed`, `aria-selected`, `aria-current`, `aria-disabled`, `aria-live` — every visual state that carries meaning has an ARIA attribute or a semantic element that carries it. |

## Common patterns

### Buttons

Native `<button>`, not `<div onclick>`. Native handles Enter, Space, focus ring, and `aria-disabled` correctly. If you must use a `<div>` (styling escape hatch): `role="button"`, `tabindex="0"`, `onKeyDown` handles Enter and Space, focus-visible outline manually.

### Toggles

`<button aria-pressed="true|false">` for a two-state toggle. `<input type="checkbox">` for a form checkbox. Never a `<div>` for either.

### Disclosures (collapsible sections)

Trigger: `<button aria-expanded="true|false" aria-controls="{{panel-id}}">`. Panel: `id="{{panel-id}}"`, `hidden` when collapsed. Focus stays on the trigger when expanding; moves into the panel only if the panel is a modal.

### Modals (dialog / alertdialog)

Use `<dialog>` element where possible. Otherwise: `role="dialog"`, `aria-modal="true"`, `aria-labelledby="{{heading-id}}"`. On open: **trap focus inside** (first focusable element gets focus; Tab wraps within; Escape closes). On close: **return focus to the trigger**. Modal without focus management is broken for keyboard users.

### Live regions (toasts, status updates)

Toasts: `role="status"` + `aria-live="polite"`. Doesn't interrupt the user's current announcement. For urgent (rare) failures: `role="alert"` + `aria-live="assertive"`. Never both on the same node.

Inline status ("Friend request sent."): `role="status"` on the container that RECEIVES the change (not on a separate span). The screen reader announces the change when the container's text updates.

### Boards / grids / games

Chess / grid-based interfaces: `role="grid"`, cells `role="gridcell"`. Selected cell: `aria-selected="true"`. Whose turn: `role="status"` region ("White to move"). Legal-move dots: NOT decorative — `aria-label="e4 (legal move)"` on each interactive target.

Pieces themselves: DO NOT `aria-hidden="true"` unless you provide the same information elsewhere. A screen-reader user needs to know "there's a knight on f3"; hiding pieces means the game is unplayable without vision.

### Selection state IS focus

If your app has an idiom like "tap piece to select, tap destination to move", the SELECTED piece should either be the currently-focused cell OR have `aria-current="true"`. A screen-reader user tabbing through cells needs to know which one is armed for a move.

### Input fields

Every input has an associated `<label>` (either wrapping or via `for`/`id`). Placeholder is NOT a label — it disappears when the user types. `aria-describedby` for help text or validation messages. Errors: `aria-invalid="true"` + `aria-describedby="{{error-id}}"`; the error node has `role="alert"` so it announces on appearance.

## Focus management on route change

SPAs break browser focus behavior. Every route change should:
1. Move focus to the new page's primary heading (`<h1>` with `tabindex="-1"` so it can receive focus).
2. Update the document title to reflect the new page.
3. Announce the transition to screen readers via `aria-live` region if the change isn't obvious.

Without this, screen-reader users have no idea the page changed.

## Keyboard-only walkthrough as a shipping gate

Add to the adversity suite (or as a manual pre-deploy check): unplug the mouse, complete the primary user flow using only keyboard. Every affordance must be reachable via Tab; every action must be triggerable via Enter / Space / Escape. Any keyboard trap (focus enters and can't leave) is a P0 defect.

## Automated checks — they catch a subset, not everything

- `@axe-core/playwright` in the e2e suite catches obvious ARIA violations, contrast failures, missing labels.
- Lighthouse in CI catches DOM-level structure issues.

Neither catches: incorrect keyboard operation, wrong focus movement, misleading `aria-label` text, ARIA that lies (`aria-pressed="true"` when the visual state says otherwise). Manual keyboard-only walkthrough remains mandatory.

## What to put in `docs/state-machines.md`

Extend the per-machine Representation section:

```markdown
### Representation

- `pending` — inline row in FriendsSection with:
  - Visual: quiet Withdraw text link, vermillion on hover.
  - Role: `button`, `aria-label="Withdraw friend request to @{{handle}}"`.
  - Keyboard: Enter/Space activates.
  - Focus after activation: returns to the parent Friends section heading.
  - Screen reader: on removal, the row's `aria-live="polite"` container announces "Friend request withdrawn."
```

If the four columns aren't filled in, the state isn't specified.

## Sources

- Codex codebase audit gap #18.
- WCAG 2.2 SC 2.1.1 (Keyboard), 2.4.3 (Focus Order), 4.1.2 (Name, Role, Value), 4.1.3 (Status Messages).
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) — canonical patterns per widget type.
