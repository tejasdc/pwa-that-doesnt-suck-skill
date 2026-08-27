# Copy discipline

*Load before writing any user-facing string — button label, toast, empty state, error, notification title, share metadata, install prompt, footer. The AI-slop tell catalogue + the read-aloud test.*

## The rule

**Plain declarative prose. The product embodies its thesis; it never explains it.**

If you have to explain the joke, it's not a joke. If the copy narrates what the design is doing, cut it. Product UI is furniture, not marketing collateral, not a portfolio caption.

## The tell catalogue — never write these in product UI

Each is a specific AI-copywriting reflex. When you write one, stop and rewrite.

### 1. Em-dash chains

"Sit down — take a breath — the game begins."

The em-dash is a signal of a designer performing pause. In product UI it reads as trying too hard. Use periods.

### 2. "X IS Y" declarations

"Chess IS conversation." "This IS how we play."

Capitalized-IS declarations are how AI copy signals "I have a thesis." In product, users don't want a thesis; they want the button. Cut.

### 3. "Not just X — it's Y" constructions

"Not just a chess app — it's a place where friendship happens."

The construction sets up a straw man ("just X") and knocks it down. Universally reads as marketing over-reach. Delete both halves.

### 4. Designer voice / thesis narration

"We believe that the best games happen between friends who take the time to sit down."

You're a chess app. Users are not there for your beliefs. Cut every sentence that starts with "we believe" / "we think" / "we love" / "we made this because" / "this is a place for" / "this is about".

### 5. Portfolio-caption tone

"A quiet board. An unhurried game. Handcrafted with love."

This is designer showreel copy — appropriate in a case study on your Behance, hostile in the app. Product UI never lyricizes itself.

### 6. Explaining provenance

"Chess pieces in the Rodchenko tradition." "A design inspired by 1925 Workers' Club aesthetics."

If the design succeeds, users feel it. If it fails, telling them the source doesn't rescue it. Museum-plaque copy in a product is embarrassment. Cut.

### 7. "So you know when a friend invites you" — the explainer-clause

Slightly softer version of thesis narration. Fine as a REASON attached to a specific action ("Enable notifications so you know when a friend invites you") because it's answering a question the user asks by hovering. NOT fine as a standing tagline.

### 8. Empty-state whimsy

"Nothing here yet — but that's how great things start!" "Your inbox is quiet. Enjoy the calm."

Whimsy in empty states IS AI copy. Real product empty states are literal: "No friends yet. Add a friend to start." Then the primary action button.

### 9. Toast fluff

"Success! Your invitation is on its way. 🎉"

Product toasts are: `Friend request sent.` Full stop. No exclamation. No emoji. No "on its way." Delete every non-load-bearing word.

### 10. Pipe notation, machine strings, mode labels leaking to UI

"10|0", "Bo3", "async_v2".

User-facing strings are always human: "10 minutes", "best of three", "asynchronous". Machine notation stays server-side.

### 11. "Not scrolled alone" / other appositive clauses attached to attribution

"Rodchenko's Workers' Club — active and collective rather than passive and solitary, not scrolled alone." The "not scrolled alone" is a designer nudge at the reader. Keep the historical quote if it's real; delete the clause.

### 12. Self-referential credits

"Photo by Tejas". "Made lovingly by @handle". Any string where the app admires itself.

Attribution is short and factual: "Rodchenko, 1925. Workers' Club (Paris)." Or nothing. Never the author complimenting themselves.

## The read-aloud test

Before shipping any string:
1. Read it aloud in a flat tone.
2. If it sounds like a designer explaining a joke, cut it.
3. If it sounds like something you'd read in a portfolio caption, cut it.
4. If it can survive being read aloud by a bored user, keep it.

## The rewrite pattern

For each cut, replace with:
- A **button label** that says what pressing it does (`Add friend`, `Sign in or sign up`).
- A **status line** that says what the state is (`Waiting for @bob`, `Friend request sent`, `Invite withdrawn`).
- A **reason clause** attached to an action if — and only if — the user needs the reason to make the decision (`Enable notifications so you know when a friend invites you`).
- **Nothing** if the string was pure decoration.

## Error messages

Errors follow a strict matrix — one canonical string per failure class, no free-form text passed from the server, no raw platform error text ever.

Reference matrix (adapt to your app):
- Sign-up cancel / dismiss → `"Passkey wasn't created — try again."`
- Sign-up platform error (WebAuthn `DOMException`) → `"Couldn't create a passkey on this device."`
- Sign-in failure with no credential → `"That handle may be taken — try a different one."`
- Server-provided error (validation, business rule) → the server's message, straight through.

Everything else falls through to a single generic error state. Never surface a raw error object, `.name`, or `.message` from a platform API.

## Notification titles — the same rule, higher stakes

Notification titles appear in the OS shell. They must be readable at a glance, human, and specific.

Wrong: "Game challenge from chess" (generic, template-shaped, uninformative)
Right: "@bob invited you to a game · 10 min"

Wrong: "New notification"
Right: "@bob accepted your invitation"

Wrong: "Reminder: You have a scheduled game"
Right: "Your game with @bob starts now"

## Notification policy — PRINCIPLE not enumeration

State the policy as a principle in `docs/requirements-ledger.md`:

> Notifications serve the user's own intention. Re-engagement notifications are banned permanently.

Then the current set is a descriptive list, not a cap: `friend_request`, `challenge`, `challenge_accepted`, `scheduled_start`. Adding a new notification means checking against the principle, not "is this in the list."

This is the rule that keeps push from turning into growth-hacking. See `references/pwa-specifics.md` for the technical side of push.

## Meta-copy: `<title>` vs wordmark

The URL carries the app's name. The `<title>` describes WHAT the app is (searchable, shareable). The in-app wordmark IS the name.

Example split:
- Wordmark, manifest `name`/`short_name` (home-screen install label), `APP_NAME` env var, passkey `rpName`: the identity (`two chairs`).
- `<title>`, `og:title`, `twitter:title`, `<meta name="description">`: what it is (`chess with friends`).
- `og:description`: the one approved product-line ("No infinite pool of opponents. A game happens when two friends sit down.").

Never let the wordmark leak into the `<title>` or vice-versa.

## The scrub pass

Before every deploy, `grep -rE "(IS \w|not just|it's not about|we believe|handcrafted|thoughtfully|beautifully|carefully|deeply|elegantly)" src/` — every hit is a candidate for deletion. Zero tolerance in product UI; a handful acceptable in marketing / about pages if they were written by a human on purpose.

## Sources

- The founding directive: "Plain declarative prose only — no AI-slop tells (em-dash chains, clever appositives, 'X IS Y' constructions, portfolio-caption tone, designer voice). Read-aloud test: if it sounds like a designer explaining a joke, cut it." (Tejas, requirements-ledger, 2026-08-04)
- Compatible skills: `no-ai-slop` and `kill-ai-slop` — deeper on prose-level slop patterns in long-form writing and marketing pages.
