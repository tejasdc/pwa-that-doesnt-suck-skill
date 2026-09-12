# Durable Objects + real-time correctness

*Load before writing any DO, touching WebSocket / alarm / storage code, or debugging "the state disappeared after 10 minutes". Cloudflare Durable Objects hibernate — state that lives only in RAM evaporates. Every rule below is a specific fix for a specific bug pattern that survived code review because it "looked correct".*

## The mental model

- **A Durable Object serializes requests through an input gate.** Two clients calling the same DO's endpoint at the same time queue on the input gate; while your handler runs it holds that gate closed. But **awaiting an external async operation like `fetch()` opens the input gate**, and another queued request can start executing before your handler resumes. Storage operations (`ctx.storage.get/put`) hold the output gate — reads and writes are ordered — but awaiting a cross-DO fetch is exactly where two "in-flight" mutations can interleave. This is the input-gate rule, and it's the reason for **Rule 4** below. See [Cloudflare — Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- **A DO hibernates.** After a period of no activity (typically ~30s), the runtime evicts the isolate. Instance fields (`this.foo = ...`) are gone. Only what's in `ctx.storage` and what the host manages for you (accepted WebSockets, alarms) survives.
- **A DO can be re-instantiated at any moment.** Design as if the class re-instantiates on every request. Any state you need across requests goes through `ctx.storage.put()`.
- **What the platform enforces vs. what's just true in the happy path.** "Single writer" describes the runtime guarantee at the input gate — NOT that you can't create races by awaiting external effects mid-mutation. Cite this distinction in your own state-machine docs; overbroad "no interleaving" claims teach the wrong architecture.

## Rule 1: NO `setTimeout` for lifecycle timers

Grace timers, expiry sweeps, cleanup delays — none of them survive hibernation. If you set a `setTimeout(..., 15_000)` and the DO hibernates 5 seconds in, the timer is gone.

**Use `ctx.storage.setAlarm(when)` instead.**

Pattern:
- On the state change that needs a future action, compute `whenMs` and write it to storage (or persist the "grace expires at" per-entity).
- Set the DO alarm to the earliest of all pending future actions (`setNextAlarm()`).
- `alarm()` handler: reads storage, does the work for whatever has come due, recomputes and re-arms the alarm.

Example: reconnect grace timer
```ts
async webSocketClose(ws: WebSocket) {
  const { userId } = readAttachment(ws);
  const survivors = this.ctx.getWebSockets().filter(s => readAttachment(s).userId === userId && s !== ws);
  if (survivors.length === 0) {
    const grace = await this.ctx.storage.get<Record<string, number>>("graceExpiresAt") ?? {};
    grace[userId] = Date.now() + 15_000;
    await this.ctx.storage.put("graceExpiresAt", grace);
    await this.setNextAlarm(); // takes min() of all wake targets
  }
}
```

## Rule 2: hibernatable WebSockets via `ctx.acceptWebSocket()`

If you keep sockets open with `server.accept()` (the classic pattern) the DO stays warm for the socket's lifetime, and event handlers are closures — which die on hibernation.

**Use `ctx.acceptWebSocket(server)` + `server.serializeAttachment({...})` + class-method event handlers.** The socket survives hibernation; the DO re-hydrates on next event.

```ts
async socket(request: Request): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const { userId, handle } = await this.authenticate(request);
  this.ctx.acceptWebSocket(server);
  server.serializeAttachment({ userId, handle });
  // Prime this specific socket BEFORE broadcasting to peers (see Rule 5).
  server.send(JSON.stringify(await this.snapshot()));
  await this.broadcast(); // fans out to everyone via ctx.getWebSockets()
  return new Response(null, { status: 101, webSocket: client });
}

// Class-method event handlers — survive hibernation.
async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) { /* ... */ }
async webSocketClose(ws: WebSocket) { /* ... */ }
async webSocketError(ws: WebSocket) { /* ... */ }
```

Keep close-handshake ownership with the runtime when the compatibility date is
2026-04-07 or later (`web_socket_auto_reply_to_close`). A close handler may perform
application cleanup, but must not blindly echo its received code through `close()`:
a browser closing without a status produces reserved code 1005, which cannot be sent.
Clarify.pm's September 2026 browser acceptance reproduced `InvalidAccessError` on
logout from that echo; an application-only close handler passed native revocation
and browser logout checks. See [Cloudflare WebSocket close behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Read per-connection metadata via `readAttachment(ws)`:
```ts
function readAttachment<T>(ws: WebSocket): T {
  return ws.deserializeAttachment() as T;
}
```

## Rule 3: connection state is DERIVED, not stored

The best fix for "connection state didn't persist" is not to store it at all. Derive it every snapshot from two hibernation-safe primitives:

- `ctx.getWebSockets()` — the durable socket set.
- `ctx.storage.get("graceExpiresAt")` — per-user grace expiry timestamps.

```ts
function computeConnectionState(userId: string, ctx: DurableObjectState, grace: Record<string, number>) {
  const socks = ctx.getWebSockets().filter(s => readAttachment(s).userId === userId);
  if (socks.length > 0) return "connected";
  if ((grace[userId] ?? 0) > Date.now()) return "reconnecting";
  return "gone";
}
```

Storage that isn't stored can't go stale. Every snapshot recomputes fresh.

## Rule 4: persist durable intent BEFORE external side effects

The input gate opens on `await`. If your handler mutates in-memory state, `await`s a `fetch()` (push delivery, webhook, cross-DO call), and THEN calls `ctx.storage.put()` — a concurrent duplicate request can enter the handler during the fetch and observe stale storage, causing both requests to commit the same mutation twice (double-created rows, double-fired pushes, double-projected state).

**Order: read → decide → PUT storage → await external side effects.** The persisted intent survives the interleave; the side effect can be re-issued idempotently (Rule 5's retry pattern) but the durable state is already correct.

```ts
// Wrong — race window between the mutation decision and the put:
async createChallenge(from: string, to: string) {
  const db = await this.getDb();
  if (existingPending(db, from, to)) return { challenge: existingRow(db, from, to) };
  const row = newChallenge(from, to);
  db.challenges.push(row);
  await sendPush(to, { type: "challenge", from });   // input gate opens here
  await this.ctx.storage.put("db", db);              // by now a duplicate may have run
  return { challenge: row };
}

// Right — persist first, then side-effect:
async createChallenge(from: string, to: string) {
  const db = await this.getDb();
  if (existingPending(db, from, to)) return { challenge: existingRow(db, from, to) };
  const row = newChallenge(from, to);
  db.challenges.push(row);
  await this.ctx.storage.put("db", db);              // durable intent committed
  this.ctx.waitUntil(sendPush(to, { type: "challenge", from })); // fire-and-forget with retry
  return { challenge: row };
}
```

**For side effects that must succeed:** persist an outbox row in the same `put`, and drain the outbox from `alarm()` with idempotent retries. Never lose a required side effect because the fetch failed after commit.

## Rule 5: cross-DO projection with retry

The AppDO's copy of a game's status is a projection of the GameDO's authoritative status. Cross-DO communication is a network call and can fail transiently.

Wrap the projection write in `ctx.waitUntil()` with up to N retries and exponential backoff:

```ts
async reportStatus(gameId: string, status: GameStatus) {
  const stub = this.env.APP_DO.get(this.env.APP_DO.idFromName("app"));
  this.ctx.waitUntil((async () => {
    const delays = [250, 500, 1000, 2000, 5000]; // cap 5s
    for (let i = 0; i < 5; i++) {
      try {
        const r = await stub.fetch("https://internal/_internal/game-status", {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal": "app" },
          body: JSON.stringify({ gameId, status }),
        });
        if (r.ok) return;
      } catch { /* transient */ }
      await new Promise(res => setTimeout(res, delays[i]));
    }
  })());
}
```

The receiving side must be **idempotent** — the same status write twice returns cleanly.

## Rule 6: read-your-writes — use the handle you hold

**Host-provided collections don't guarantee same-request read-your-writes.** `ctx.acceptWebSocket(server)` accepts the socket, but `ctx.getWebSockets()` called immediately after may not include it (observed in `wrangler dev`; adversity test reproduced it).

**Pattern:** when you write to a host-managed collection and immediately need to act on that write, use the handle you already hold. Don't re-derive from a read.

```ts
// Wrong:
this.ctx.acceptWebSocket(server);
for (const ws of this.ctx.getWebSockets()) ws.send(snapshot); // may miss server

// Right:
this.ctx.acceptWebSocket(server);
server.send(snapshot); // prime the just-accepted socket directly
this.broadcast(); // fan-out to peers via ctx.getWebSockets() — the write is for them
```

## Rule 7: single alarm for multiple concerns

If your DO has multiple wake targets (game-clock deadline + N grace expiries + scheduled event), you have ONE `ctx.storage.setAlarm` slot. Take the `min()` of all targets:

```ts
async setNextAlarm() {
  const wakes: number[] = [];
  const grace = await this.ctx.storage.get<Record<string, number>>("graceExpiresAt") ?? {};
  for (const t of Object.values(grace)) wakes.push(t);
  const game = await this.ctx.storage.get<Game>("game");
  if (game && game.status === "active") {
    const mover = game.turn === "w" ? game.whiteMs : game.blackMs;
    wakes.push(Date.now() + mover);
  }
  if (wakes.length === 0) return;
  await this.ctx.storage.setAlarm(Math.min(...wakes));
}

async alarm() {
  // Sweep grace expiries, apply clock, promote to terminal if needed.
  // Then re-arm.
  await this.setNextAlarm();
}
```

## Rule 8: dead push endpoints — cleanup on 410 / 404

Every push subscription eventually goes bad (user uninstalls, revokes permission, changes device). The push service replies `410 Gone` or `404 Not Found`. Clean up in the SAME transaction as the log write:

```ts
async enqueuePush(userId: string, payload: PushPayload) {
  const subs = (await this.getDb()).pushSubscriptions[userId] ?? [];
  for (const sub of subs) {
    const res = await sendWebPush(sub, payload, this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    if (res.status === 410 || res.status === 404) {
      await this.removePushSubscription(userId, sub.endpoint);
    }
    await this.logPush(userId, sub.endpoint, res.status);
  }
}
```

No manual reconciliation, no admin sweep. Dead endpoints prune themselves.

## Rule 9: TTL sweeps run on BOTH the allocation path AND the completion path

For bounded ephemeral data (auth challenges, temporary uploads, in-flight nonces), sweeping only on the completion path (verify handler) leaves an unbounded backlog when allocations are made and abandoned — the failure mode attackers exercise, and the failure mode any user who taps `/options`, walks away, and never comes back exhibits.

**Fix: sweep on the ALLOCATION path too.** Every place that allocates a row runs the sweep before the write, plus every place that reads the row. Cheap, keeps the table bounded regardless of user behavior.

```ts
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function sweepExpiredChallenges(db: Db) {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [k, entry] of Object.entries(db.registrationChallenges)) {
    if (entry.createdAt < cutoff) delete db.registrationChallenges[k];
  }
  for (const [k, entry] of Object.entries(db.authenticationChallenges)) {
    if (entry.createdAt < cutoff) delete db.authenticationChallenges[k];
  }
}

async registrationOptions(handle: string) {
  const db = await this.getDb();
  sweepExpiredChallenges(db);         // <-- allocation-site sweep
  db.registrationChallenges[handle] = { challenge, createdAt: Date.now() };
  await this.ctx.storage.put("db", db);
  // ...
}

async registrationVerify(...) {
  const db = await this.getDb();
  sweepExpiredChallenges(db);         // <-- completion-site sweep
  // ...consume the challenge, verify, delete it
}
```

**For every ephemeral record, write down (in `docs/state-machines.md`) the four values: TTL, cap, allocation-site cleanup, completion-site cleanup.** All four must be answered; the fourth being "verify handler" alone is Codex-audit gap #7's specific incident.

## Rule 10: alarm rearms after EVERY mutation that could change the wake target

If you set `graceExpiresAt` in `webSocketClose`, call `setNextAlarm()` in the same handler. If you accept a new schedule that's earlier than the currently-armed alarm, call `setNextScheduleAlarm()` in the accept handler. Forgetting to re-arm is how alarms silently drop.

`setNextAlarm()` computes `min()` of all wake targets and calls `ctx.storage.setAlarm(when)`. Idempotent. Call it liberally.

## Rule 11: classify state hot/cold before you pick the storage shape

The "single JSON blob" pattern (Rule 12 below) is right ONLY for state that reads/writes together at a low-to-moderate frequency. Hot ephemeral state — presence heartbeats, cursor positions, typing indicators — should NOT share the same blob as your durable account data. A 10s heartbeat that rewrites the full app blob turns every online user into a full-app-storage-rewrite bottleneck.

**Classify every piece of state as one of:**

| Class | Storage shape | Example |
|---|---|---|
| Durable + cold (rarely changes) | Single JSON blob, or key-per-entity | Accounts, friendships, notification prefs |
| Durable + hot (changes on many actions) | Key-per-entity, avoids full-blob rewrite | Games in flight, live invitations |
| Ephemeral + hot (transient signal) | Separate DO or DO input, NOT the blob | Presence heartbeat, cursor position, typing |
| Ephemeral + cold (bounded, TTL'd) | Blob is fine, sweep on allocation + completion | Auth challenges, nonces |

**Presence heartbeat specifically:** put it in a small dedicated DO keyed by shard (e.g. hash of user id modulo N), NOT the account-scoped `AppDO`. Or use a KV write with a short TTL if the exactness of "last seen" doesn't need transactional semantics. The reference project put presence into the AppDO blob and every 10s heartbeat rewrote the entire app database; recognized in the audit as a latent scale bottleneck.

## Rule 12: DO storage is a single JSON blob if you can afford it

For an account-scoped DO with a small dataset (all users, all friendships, all challenges, all schedules for a friends-only app), a single JSON blob keyed `"db"` is simpler than key-per-entity. Full-document read + full-document write per mutation. Trades write bandwidth for lock-free reads within a request.

Threshold: switch to key-per-entity when the blob grows past ~1 MB, when write frequency makes the read-modify-write cycle a bottleneck, or when the classification above says the state doesn't belong in the blob at all.

## Rule 13: recurrence is civil time, not fixed milliseconds

People schedule "Tuesday at 7pm", not "+604800000ms". DST changes, timezone changes, and month-boundary crossings all break fixed-millisecond advancement.

**Wrong:**
```ts
function advanceFireTime(prev: number, rec: Recurrence): number {
  if (rec.kind === "daily")  return prev + 24 * 60 * 60 * 1000;
  if (rec.kind === "weekly") return prev + 7 * 24 * 60 * 60 * 1000;
  return prev;
}
```

**Right:** store the timezone + local wall-clock fields (hour, minute, weekday), not only the epoch millisecond. Advance in civil time using a library that respects the stored TZ.

```ts
type Recurrence =
  | { kind: "once" }
  | { kind: "daily";  tz: string; hour: number; minute: number }
  | { kind: "weekly"; tz: string; hour: number; minute: number; weekday: 0|1|2|3|4|5|6 };

// Advance in the recurrence's timezone; return the next absolute instant.
function nextFireAtCivil(prev: number, rec: Recurrence): number {
  // Use Temporal (or Luxon / date-fns-tz) — resolves ambiguous local times,
  // handles DST spring-forward / fall-back correctly.
  // ...
}
```

**If the product is genuinely "notify me every 24h regardless of clock" (e.g. a game-loop tick):** say so in `docs/state-machines.md` and use fixed millis knowingly. Otherwise assume civil time; the failure mode is user-visible ("my Tuesday 7pm game fired at 6pm this week because DST rolled back").

## Rule 14: bootstrap payload has cardinality budgets

A phone opening the app pays for every byte and parse. If your `/api/me` (or `/api/bootstrap`) returns every game the user ever played, every message, every notification log entry, cold-start time grows linearly forever.

**Rule:** every array in a bootstrap payload has a documented cardinality budget in `docs/state-machines.md`. Common budgets:

- Active/live entities (games in flight, incoming invitations): unbounded — but these are typically bounded by user behavior. Cap defensively at ~200 with a "load more" affordance.
- Recent-history slices (last 20 completed games, last 50 notifications): explicit `limit` at the query.
- Full history: paginated. Cursor-based, not offset — DOs don't like large offsets.

**Implementation shape:** `/api/me` returns the shallow bootstrap; `/api/games?before=<cursor>&limit=20` returns historical slices.

The reference project sent all games in `/api/me` and sliced client-side. Works for a private friends app with <50 games per user; ships as unbounded latency the moment somebody plays 500 games.

## Testing DO lifecycles — the time-warp harness

See `references/verification-stack.md` for the pattern. TL;DR: expose a local-only `POST /_debug/tick` endpoint on the DO that shifts due timestamps into the past and invokes `alarm()` directly. Adversity test uses it to verify expiry, recurring-schedule advancement, and cleanup sweeps without waiting real seconds.

## Config knobs in `wrangler.jsonc`

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "APP_DO", "class_name": "AppDO" },
      { "name": "GAME_DO", "class_name": "GameDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AppDO", "GameDO"] }
  ]
}
```

`new_sqlite_classes` (not `new_classes`) gives you the SQLite-backed DO storage tier. Do this from the start; it's not a free migration later.

## Sources

- Reference implementation: `src/worker.ts` in the chess-with-friends project. AppDO + GameDO patterns as shipped.
- All GAP-8 through GAP-13 in `docs/state-machines.md` are the specific bugs each rule above fixes. Read that file for the exact commits.
- Cloudflare docs: "Durable Objects — Hibernation", "WebSockets in Durable Objects — acceptWebSocket API", "Storage API — Alarms".
