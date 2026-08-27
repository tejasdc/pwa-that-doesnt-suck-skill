# Interaction feedback taxonomy

*Load before adding any toast, banner, alert, snackbar, popup, or "you can't do that" message. This is the reference the top-level `silent-board-during-play` invariant points at — a reusable taxonomy of feedback channels so agents know which failure gets disabled controls, which is a silent no-op, which is inline status, which is a toast, and which (rarely) escalates to an OS notification.*

## The rule

**Feedback is ranked by LOCUS (where the user is looking) and SEVERITY (how much they need to act). Wrong locus + wrong severity is how a product becomes noisy and then insulting.**

Every interaction has a natural locus — the button they tapped, the field they typed in, the surface they're playing on. Feedback belongs at that locus unless it announces something the user isn't looking at.

## The five channels

| Channel | Locus | Severity | When to use |
|---|---|---|---|
| **Prevented (disabled control)** | The control itself | Silent | The action isn't legal from the current state. Disable the button; don't let the user commit and then reject. |
| **Silent no-op** | The surface they're on | Silent | The action was legal to attempt but had no effect (tapping empty space, deselecting, tapping own piece off-turn). No feedback because there was no failure. |
| **Inline status** | Adjacent to the control | Low | The action succeeded and there is a state change worth naming ("Friend request sent."). One line, close to the action. |
| **Toast** | Bottom / top edge of screen | Medium | A **system failure** happened outside the user's fault (network dropped, server 500, sync conflict). NOT for validation, NOT for "invalid input", NOT for "not your turn". |
| **OS notification (push)** | Outside the app | High | The user is not looking at the app and something happened that serves their own intention (an invitation, a scheduled event start). See `references/pwa-specifics.md` and `references/push-delivery-and-service-worker.md` for the policy. |

## The "silent board during play" principle

**During direct manipulation of a domain object (chess board, canvas, drag-drop grid), the OBJECT is the only feedback channel.** The board tells you legal moves via visible dots on legal squares; illegal-destination taps clear the selection; off-turn taps do nothing; own-piece taps when it's not your turn do nothing.

**Never toast a domain-rules failure during play.** "Not your turn" is not information the user needs — they can see whose turn it is. "Invalid move" is not information they need — the board didn't accept the move, that's evidence enough. Toasting during play is insulting; the user knows what they tried, they can see it didn't work, they don't need a banner explaining it.

**The corollary:** if the failure needs a toast to be understandable, the surface is under-communicating. Fix the surface, don't add the toast.

## Prevention over rejection

Every "you can't do that" that ends in a toast is a design failure — the affordance existed to be pressed but pressing it failed. Instead:

- **Disable the control.** If the user can't invite themselves, the invite button on their own row is disabled. Cursor: not-allowed. No toast when they somehow click it.
- **Hide the affordance.** If the user shouldn't be able to withdraw a challenge they didn't send, the withdraw button doesn't render on that row.
- **Make illegal transitions silent no-ops** at the interaction level. Tap on own piece off-turn: `if (piece.color !== turn) return;` — no toast, no selection state change, no request.

Toasts are the last resort, not the first.

## Toast usage — the tight rules

If you're going to toast, follow all four:

1. **System failure only.** The user did nothing wrong; something outside their control went wrong.
2. **Copy names the thing.** `"Couldn't reach the server. Retrying…"` — specific, not `"Something went wrong."` (see `references/copy-discipline.md`).
3. **Auto-dismiss ~4 seconds.** Long enough to read, short enough not to linger.
4. **Single slot; last write wins.** No toast stacks. If two failures happen, the second replaces the first. Toast stacks are anti-UX.

## Inline status — the affirmative confirmations

Successful state changes get inline status close to the action:
- After `POST /api/friends/request`: `"Friend request sent."` below the input, one-line.
- After `POST /api/challenges`: navigate to the waiting room; the destination screen IS the confirmation ("waiting for @bob").
- After `POST /api/schedules`: the schedule row appears in the list with its confirmed time.

Never both — a status line AND a toast for the same success is redundant.

## Empty states are ANNOUNCEMENTS, not errors

An empty list is a state, not a failure. Empty-state copy is literal, gives the primary action:
- `"No friends yet. Add a friend to start."`
- `"No games in play. Invite a friend."`
- `"No notifications yet."`

Never whimsy ("Enjoy the calm."). Never apology ("Nothing to see here."). See `copy-discipline.md` rule #8.

## Error boundary != toast

If your React error boundary catches a render error, the recovery is NOT a toast. It's an in-place reset (see `react-imperative-animation.md`). The user should experience a flicker at worst, not a `"Something went wrong"` banner. Log to the console for observability; do not surface the error itself.

## Modality — reserved for consequences

Modal dialogs (confirm, alert, prompt) are for actions the user cannot undo cheaply:
- Confirm before deleting an account.
- Confirm before ending a series of recurring scheduled events.

Never a modal for "you sure you want to send this invitation?" Sending is undoable via withdraw; a modal is friction.

## The taxonomy in one grep

Before shipping any feedback UI, `grep -rE "toast|Snackbar|alert\\(|showNotification|banner" src/` and check each hit against the rule:
- Is this a system failure? → toast is right.
- Is this a domain-rules failure during play? → silent no-op is right; DELETE.
- Is this a state-change confirmation? → inline status is right.
- Is this something the user isn't looking at? → OS notification is right.
- Is this an action the user can't take? → disabled or hidden control is right; DELETE the toast.

## Sources

- Codex review gap #10 (`silent-board` was named as an invariant but had no reusable recipe until this file).
- The `no toast during gameplay` requirement in the reference project's `docs/requirements-ledger.md` (originally born of the "invalid move notification. Bullshit!" incident from the transcript).
