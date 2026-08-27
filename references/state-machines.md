# State machines first

*Load this before adding any lifecycle, status field, or boolean-flag pair. This is the pattern that prevents "the invite still says `Invite` after I sent one" — the founding bug of every stateful app that grew feature-by-feature instead of machine-by-machine.*

## Vocabulary (say the words out loud)

- **State** — one of a finite, disjoint set of conditions an entity can be in. A machine is in exactly one state at a time. "Active with `winnerId` set" is not a state; it's a projection. `checkmate` is a state.
- **Event** — the thing that fires. HTTP request, alarm, WebSocket frame, timer, deploy. Named for what happened, not what should happen next.
- **Transition** — `(state, event) → state`, optionally with a guard.
- **Guard** — the precondition that must hold. If it fails, the event is rejected; the state doesn't change.
- **Single writer** — the ONE place in the codebase allowed to mutate the entity's state. Everyone else reads. On Cloudflare Workers this is a Durable Object; on other stacks it's a service module with a mutex or a well-defined lock.
- **Projection** — a client-side view derived from the writer's state. Projections are read-only. When they disagree with the writer, the writer wins on the next refresh.
- **Closure** — the guarantee that every state has an exit. A state you can enter but never leave is a defect regardless of how rare the entry.
- **Representation** — the UI shape a state takes. A state without a representation is a state the user can't act on. If two states share a representation, the UI can't tell them apart and neither can the user.

## The eight rules

### 1. If it has a lifecycle, it has a state machine

Any entity whose meaning depends on when you look at it carries a lifecycle. That lifecycle belongs in `docs/state-machines.md` before the code lands, not after. If you can't name the states, you're not ready to write the code.

**Test:** read your PR out loud. If sentences include "sometimes X", "usually Y", or "after a while Z", those are transitions you haven't named.

### 2. One writer per machine

Exactly one place in the codebase mutates a machine's state. On Cloudflare Workers the writer is a Durable Object — per-DO request serialization gives you the single writer for free. The client NEVER writes authoritative state; it dispatches events by calling the writer's API.

**Test:** if a reviewer asks "what if two clients do X at once?" and the answer isn't obviously "the writer serializes them", the design is wrong. Add the guard, don't add locking.

### 3. Server is authority; client renders a projection

Optimistic UI is fine when the write is cheap and reversible. Even then, the client shows what the server would show after the write lands — never a state the server can't reach. When the server reply arrives, the projection catches up. Don't invent client-only states.

### 4. Every mutation is idempotent

Every write endpoint must be safe to call twice. The second call is a no-op that returns the current state.

- `create-*`: a second call with the same key returns the existing row — never duplicates, never fires a duplicate push.
- `accept-*` / `decline-*` / `withdraw-*` / `cancel-*`: guarded on current status; a second call from a terminal state is a success returning current state, not an error.

Idempotency is what makes retries safe AND defends against the double-tap.

### 5. Every state has a representation on every surface where the entity is user-relevant

If a Challenge is `pending` and the inviter is looking at the Friends list, the ROW FOR THAT FRIEND must reflect it. If a Schedule is `accepted`, the row must reflect it on both parties' dashboards.

Do NOT project into ambient UI (global banner, toast). Representation goes where the entity lives — the friend row, the schedule row, the game row.

**Test:** for every state, name the file:line where the projection is computed for each surface. If you can't cite the line, the projection doesn't exist.

### 6. Every state has an exit

Every state — including `pending`, especially `pending` — has at least one transition out that a user or the system can trigger. If the only way to leave `pending` is for the other person to act, that's a defect. Design the withdraw / decline / expire path IN THE SAME ROUND as the create path.

The exception is a true terminal state (`checkmate`, `fired`, `cancelled`). Terminals are exits. But `pending` is not a terminal.

Where expiry is right (a schedule whose `startAt` has passed), it runs on an alarm and marks a distinct terminal (`expired`), not silently mutates the row.

### 7. Model the machine, not scattered flags

If a feature accumulates two or more booleans to describe its state (`isPending`, `hasAccepted`, `wasWithdrawn`), replace them with a single `status` union.

Preferred:
```ts
type EntityStatus = "pending" | "accepted" | "declined" | "withdrawn";
interface Entity {
  id: string;
  status: EntityStatus;
  // status-scoped fields (winnerId when terminal, gameId when accepted) alongside
}
```
Not: `{ isPending, isAccepted, cancelled, fired }`. Boolean soup makes illegal states representable.

### 8. New features ship with their machine documented AND tested

A PR that adds a lifecycle without adding the states and transitions to `docs/state-machines.md` in the same change is incomplete. A PR that documents states but doesn't cover them in the adversity suite is incomplete. Tests must exercise EVERY transition — including withdraw / decline / expire, not just accept.

### 9. Presence is a projection, not an authorization guard

Presence — "is this user online right now" — is a rendering signal, not a permission. Gating an action on presence ("only allow invite when the friend is online") defeats the point of push and locks offline users out of the flow that would notify them.

**Wrong:**
```ts
// Invite button disabled if friend not online — misses the whole point.
<button disabled={!friend.online} onClick={invite}>Invite @{friend.handle}</button>
```

**Right:**
```ts
// Invite always active; the push IS the come-online request.
<button onClick={invite}>Invite @{friend.handle}</button>
// Presence renders as a dot / status label, not as an authorization gate.
```

Exception: **product genuinely requires simultaneity** (live-only voice call, screen-share invite where both must be present). Say so explicitly in `docs/state-machines.md`. Default is: presence changes representation, never authorization.

**Test:** the adversity suite includes "offline recipient can receive pending invitation on next open". If it can't, presence is being used as a guard somewhere.

### 10. Every event path reconciles every projection

A transition is complete only when EVERY projection has been updated. If `move` (event) can reach `timeout` (state) via `snapshot-read` OR via `clock-alarm`, both paths must reconcile the AppDO projection, both must broadcast the terminal to sockets, both must fire the terminal push. Missing any column on any path leaves stale projections.

**Build a transition table with a column per projection concern:**

| Event | State after | Storage write | Broadcast | Push | Alarm rearm | Cross-DO projection |
|---|---|---|---|---|---|---|
| `move` (checkmate) | `checkmate` | ✓ | ✓ | ✓ | clear | ✓ |
| `resign` | `resigned` | ✓ | ✓ | ✓ | clear | ✓ |
| `clock-alarm` (timeout) | `timeout` | ✓ | ✓ | ✓ | clear | ✓ |
| `snapshot-read` (observed timeout) | `timeout` | ✓ | ✓ | ✓ | clear | ✓ |

If any cell reads ✗ or blank, it's a gap — file it in `docs/state-machines.md` and either close it now or acknowledge it explicitly (`no-op because ...`).

The reference project shipped a gap here: `snapshot-read`-observed timeouts reported to AppDO; `move`-observed and `clock-alarm`-observed timeouts skipped that report path. Dashboard showed live-game rows for games that had timed out because the projection never caught up.

### 11. Semantic visual annotations assert data from domain truth, not pixels

If your UI paints something derived from domain state — "last move" highlight, "check" indicator, "winner" banner — that annotation is a projection of the domain. Assert it against the domain source, not against pixel screenshots alone.

**Wrong:**
```ts
test("last move highlight visible", async ({ page }) => {
  await expect(page.locator(".last-move-highlight")).toBeVisible(); // proves it EXISTS, not that it's CORRECT
});
```

**Right:**
```ts
test("last move highlight on from AND to squares of the last move", async ({ page }) => {
  // Play e2-e4.
  await move(page, "e2", "e4");
  // Assert both squares have the highlight attribute, and no others do.
  const highlighted = await page.locator("[data-last-move]").evaluateAll(
    els => els.map(e => e.getAttribute("data-square"))
  );
  expect(highlighted.sort()).toEqual(["e2", "e4"]);
});
```

Pixel presence is not correctness. Semantic annotations get data-attribute assertions against a domain truth source (`chess.js` history, your game-log store, whatever the entity's authoritative log is).

## Per-feature checklist

Before opening a PR that adds or changes a lifecycle, answer all of these in the PR description. If a line is blank, the feature is not ready.

1. **States.** What disjoint states can this entity occupy? Name each.
2. **Events.** What events cause transitions? For each event, what's the guard?
3. **Transitions.** For each `(state, event)` pair, what's the next state? Draw the mermaid diagram.
4. **Writer.** Which DO / service owns writes? Cite the specific handler.
5. **Idempotency.** For every write event, what does the second call do? Show the guard in the handler.
6. **Representation.** For every state, on every surface where the entity is user-relevant, what does the UI render? Cite the file:line where the projection is computed.
7. **Closure.** For every state, name the transition that exits it. If an exit is missing, name that as the P0 gap and either fix it now or file it in `state-machines.md`.
8. **Test.** Which test in `tests/adversity.spec.ts` covers each transition? Which matrix cell in `scripts/visual-matrix.mjs` covers each representation?

## Anti-patterns to reject in review

- **A `status` string used as free text.** If the string can be anything, it's not a state. Type it as a union.
- **A client-side `pending` the server doesn't know about.** Optimistic UI must still reflect what the server would show. Don't invent client-only states.
- **Two writers.** If two files can mutate the same field, one is wrong. Even inside the same DO, funnel mutations through a single method with the guard inside.
- **A `useEffect` that polls forever with no exit.** Every polling loop has stop conditions — every terminal the polled entity can reach, plus unmount. When the entity grows a new terminal, the loop grows a matching exit branch IN THE SAME CHANGE. A loop that only exits on the happy-path terminal turns every other terminal into a spinning bug.
- **A `setTimeout` in a Durable Object.** Not durable across hibernation. Use `ctx.storage.setAlarm` or a stored `expiresAt` promoted lazily on read. See `durable-objects.md`.
- **Reading a write from the same request.** Host-provided iterators (`ctx.getWebSockets()`) are not guaranteed to reflect a `ctx.acceptWebSocket(server)` call made earlier in the same request. If you need to act on the write, use the handle you already hold; broadcast to peers via the iterator, prime the just-accepted connection directly. See `durable-objects.md`.
- **A projection not marked as one.** If a field exists in two places, the copy is a projection. Name it in a comment; make the reconciliation path explicit (retry, resync, acknowledged lag).
- **Adding a status value without adding the transition into it.** If the union grows a new state, some event must create it. If nothing does, delete the value.

## Four "good-looks" patterns

Once you've built them, imitate them. These are the shapes that shipped.

### 1. Idempotent handshake with named terminals

A `use-invite-link` handler resolves five cases — self-link, already-friends, pending in either direction, no relationship, signed-out — to a friendship or a named error. Same call twice returns `already-friends` and mutates nothing. Every terminal maps to a status the client renders.

**Pattern:** enumerate the branches, name a terminal for each, make the second call safe. If a reviewer can ask "what if this fires twice?" and you don't have a one-line answer, the handler isn't done.

### 2. Symmetric exits with terminal preservation for an observed lifecycle

An invitation machine's `withdraw` and `decline` handlers are both idempotent, both guarded on the appropriate participant, both set a distinct terminal (`withdrawn` / `declined`). The polling surface reads the terminal and renders a matching outcome.

**Pattern:** when a lifecycle has an observer (a polling surface, a UI screen the actor sits on), the terminal must survive long enough for the observer to see it. Do NOT delete the row. Set a terminal status; let the read-side filter decide who sees it and for how long.

### 3. Hard delete when the lifecycle has no observer

A friend-request `withdraw` handler hard-deletes the row instead of setting a `withdrawn` terminal. The sender has no dedicated waiting surface, so nothing polls for a terminal; a persisted `withdrawn` row would be a ghost. Idempotent by returning `status: "gone"` on a missing row.

**Pattern:** the observer decides terminal-vs-delete, not the entity. Ask "what would read this?" — if the answer is "nothing", delete.

### 4. Prime the just-written handle instead of re-reading the set

The DO `socket` handler accepts a new WebSocket via `ctx.acceptWebSocket(server)`, then calls `server.send(...)` with the current snapshot BEFORE calling `broadcast()` (which iterates `ctx.getWebSockets()`). The host's socket iterator is not guaranteed to reflect the just-accepted socket in the same request cycle — a read after the write can miss it.

**Pattern:** when you write to a host-managed collection and immediately need to act on that write, use the handle you already hold. The read is fine for the fan-out to everyone else. See `durable-objects.md` for the read-your-writes hazard in general.

## Two derived rules that pay for themselves

- **Terminal preservation is an observer-driven decision.** Delete when nothing watches; keep the terminal when a screen sits on the outcome.
- **A projection is a copy; a copy needs a reconciliation strategy.** Idempotent retry (`ctx.waitUntil()` with backoff) is the default. Silent divergence is the failure mode.

## Sources

- Every rule and pattern above is drawn from `docs/state-machines.md` (audit + model, 7 machines) and `docs/state-machine-rules.md` (the 8 rules + anti-patterns) in the reference project. Read those files if you want the specific gap numbering (GAP-N) and the exact commits that closed each.
- Compatible sister skill: `stateful-shapes` — deeper on FSM design theory for chat / workflows / actors.
