# Push delivery + service worker

*Load before writing any push handler, service worker `push` event, or notification tag scheme. This is the class of bug where the permission is granted, the subscription is registered, the server sends the push, and the user still misses the event.*

## What this reference covers

Push permission (asking the user), push policy (what pushes exist), and push copy live in `references/pwa-specifics.md` and `references/copy-discipline.md`. This file is about **delivery correctness** — what happens between the server calling `sendWebPush` and the user seeing an OS notification.

## Rule 1: `showNotification` awaits — and the queue drains AFTER success

The service worker's `push` event handler pattern that ships broken:

```js
// Wrong — GET drains the queue destructively, showNotification isn't awaited:
self.addEventListener("push", (event) => {
  event.waitUntil(fetch("/api/push/pending").then(async (r) => {
    const payload = (await r.json()).payload;      // server already shifted it
    self.registration.showNotification(payload.title, payload); // not awaited
  }));
});
```

Failure modes stacked here:
- The GET request drained the queue on the server side (see Rule 4 below).
- `showNotification` returns a Promise that resolves when the notification is displayed. Not awaiting it means the event handler can complete before the OS actually shows the notification — some browsers drop the notification when the handler exits.
- If `showNotification` throws (rare, but happens on payload validation errors), the queue is already drained — the event is lost forever.

**Right shape:**

```js
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    // The payload arrives IN the push event itself (or in a POST-only drain
    // endpoint that returns it without deleting). GETs never mutate.
    const data = event.data ? event.data.json() : await drainPendingViaPost();
    for (const p of data.payloads) {
      // AWAIT display before acking. If display fails, ack is not sent,
      // server retries via alarm on the next visibility change.
      await self.registration.showNotification(p.title, {
        body: p.body,
        tag: p.tag,              // per-entity tag; see Rule 3
        data: { eventId: p.id }, // for click-through routing
        icon: "/icon-192.png",
      });
    }
    // Only ACK the events after all displays succeeded.
    await fetch("/api/push/ack", {
      method: "POST",
      body: JSON.stringify({ eventIds: data.payloads.map(p => p.id) }),
    });
  })());
});
```

## Rule 2: GET must not mutate — pending endpoints are POST only

The reference project shipped a `/api/push/pending` endpoint that accepted both GET and POST, and both paths shifted the pending queue. Browsers prefetch GETs, service workers may replay them, crawlers hit them. Any of those drains user notifications silently.

**Rule:** GET/HEAD are read-only, always. POST/PUT/PATCH/DELETE are commands. Route-inventory in `docs/state-machines.md`:

```
GET  /api/health            — read
GET  /api/me                — read
POST /api/push/pending      — command (drain returns payloads, does not delete)
POST /api/push/ack          — command (deletes acked event ids)
POST /api/challenges        — command
DELETE /api/friends/requests/:id — command
```

Any exception (a GET that mutates for "convenience") needs a hard justification in the doc AND a comment in the handler citing why.

## Rule 3: notification identity is per event or per entity, never only per category

Notification `tag` is a REPLACEMENT KEY. When a new notification arrives with the same tag, it replaces (not appends to) the previously shown one. Tagging by type collapses distinct human actions into one notification.

**Wrong:**
```js
// Every incoming challenge shares tag: "challenge" — bob's second challenge
// replaces alice's still-visible one. The user only sees "one".
showNotification("New challenge", { tag: "challenge", body: p.body });
```

**Right — per entity:**
```js
// tag = "challenge:{{challengeId}}" — distinct challenges never collide.
showNotification(p.title, { tag: `challenge:${p.challengeId}`, body: p.body });
```

**Right — per event when the entity should coalesce:**
```js
// Clock ticks for the same game — you want the LATEST to replace the previous.
// tag = "clock:{{gameId}}" — same game's clock updates replace, distinct games don't collide.
showNotification(p.title, { tag: `clock:${p.gameId}`, body: p.body });
```

**For each notification type, decide the replacement key in `docs/state-machines.md` — "replace previous X for same Y" — and encode it in the tag. Never rely on a category-only tag except for genuinely singleton events (e.g. "background sync completed").**

## Rule 4: outbox pattern, not "just call sendWebPush"

Push delivery fails: network flaps, push service returns 5xx, endpoint returns 410 (dead subscription — see `durable-objects.md` Rule 8). A handler that calls `sendWebPush` synchronously and moves on drops events silently.

**Outbox pattern:**

1. Every notification-triggering mutation persists a `pendingPush` row IN THE SAME `ctx.storage.put()` as the state change (see `durable-objects.md` Rule 4). Row: `{ id, userId, endpoint, payload, attempts: 0, nextAttemptAt: now }`.
2. A dedicated alarm drains due `pendingPush` rows: sends via `sendWebPush`, on 200/201 deletes the row, on 410/404 deletes the row AND the subscription, on 5xx bumps `attempts` and sets `nextAttemptAt = now + backoff(attempts)`.
3. After max attempts, moves the row to `deadLetter` for admin visibility (or deletes if you'd rather lose it than accumulate).

Server-side ack from the client's SW (Rule 1) is a SECOND signal: if the client acks before the alarm retries, delete the row on ack.

## Rule 5: service worker activation cleans up old caches

An installed PWA lives for months. Each deploy that bumps `CACHE_NAME` without deleting old caches accumulates them — device storage grows, offline debugging gets confused about which shell is serving.

```js
const CACHE_NAME = "app-v42"; // bump on every deploy touching cached assets

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Delete every cache except the current one.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    // Take control of open pages that were loaded under the old SW.
    await self.clients.claim();
  })());
});
```

**Deployment invariant:** every deploy that bumps `CACHE_NAME` includes at least one full opened-pinned-tab test (open on a phone, deploy, refresh, verify the new hash serves without a hard reload) plus the activate cleanup runs at least once. Verify with `caches.keys()` from DevTools on the deployed origin — should be exactly one entry.

## Rule 6: notification click routing

`showNotification`'s `data.eventId` (or `data.route`) survives to `notificationclick`. Handle it:

```js
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = event.notification.data?.route ?? "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    // If a window is already open on this origin, focus + navigate it.
    for (const c of clients) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: "navigate", route });
        return;
      }
    }
    // Otherwise open a new one at the target route.
    await self.clients.openWindow(route);
  })());
});
```

Without this handler, tapping a notification opens a blank tab or focuses whatever page happened to be last. The user is confused. Route from the notification to the entity that caused it (the specific challenge, the specific game).

## Rule 7: two-same-type push regression test

A push suite that only sends ONE push per type never exercises the tag replacement rule. Add a regression test:

- Send push A of type X to user U.
- Verify U's SW shows notification A.
- Send push B of type X to user U (different entity id).
- Verify U's SW shows BOTH A and B simultaneously (per-entity tag; Rule 3).

Playwright can drive this via `page.evaluate(() => Notification.requestPermission())` + a virtual push server, or via a headed test on the installed PWA. If neither is practical, at minimum unit-test the tag-computation function against the "no collision" invariant.

## Rule 8: subscribe-after-standalone

An installed iOS PWA has a separate subscription from the Safari tab (see `pwa-specifics.md`). A user who subscribed in Safari, then installed to Home Screen, has ZERO subscription registered for the installed app. Push sent to their tab subscription goes to a tab that isn't open.

**Detect standalone mode and re-prompt if unsubscribed:**

```ts
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as any).standalone === true;

if (isStandalone) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub && Notification.permission !== "denied") {
    // Show the enable-notifications affordance in the installed-app UI.
  }
}
```

## Sources

- Codex codebase audit gaps #4, #5, #6, #15 (from `tmp/reviews/codex-skill-gaps.md`).
- Cloudflare — [Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
- W3C — [Push API](https://www.w3.org/TR/push-api/); MDN — [`ServiceWorkerRegistration.showNotification`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).
