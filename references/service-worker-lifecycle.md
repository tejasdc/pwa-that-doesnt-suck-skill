# Service-worker lifecycle

## Rule A — the installed PWA updates itself, and only when the person says so

New code is **offered, never imposed.** When a deploy produces a new service worker, it
installs and then waits. The app shows that an update is ready, says in plain words what
the update changes, and applies it only when the person taps **Update**. Nothing else
(a timer, a navigation, a native shell, a focus change) switches the running app to new code.

Tejas, 2026-10-07: "the Update button requests an update instead of automatically
installing updates. I think that is key. Should make sure that people are aware of
what's going on and also understand what features are in there"
[decision: pwa-updates-are-offered-not-imposed].

**Why.** An automatic switch reloads the app under the person: it can discard an unsaved
draft or a live recording, it changes behaviour without warning, and a person who did not
see a change cannot tell a new feature from a bug. A person who chose the update knows the
app changed and what to look for.

### The contract

1. **Register in prompt mode.** The new worker waits. No `skipWaiting()` on install, no
   `registerType: 'autoUpdate'` (vite-plugin-pwa), no `location.reload()` on
   `controllerchange` unless this window's own Update tap started it. The waiting worker
   activates only on a message the Update button sends. Native contracts:
   [vite-plugin-pwa prompt for update](https://vite-pwa-org.netlify.app/guide/prompt-for-update),
   [Workbox `messageSkipWaiting`](https://developer.chrome.com/docs/workbox/handling-service-worker-updates).
2. **Say what is in it.** Each build publishes short, plain release notes for its version
   (one or two lines per user-visible change, written for the person, not a commit log).
   The update notice reads the *waiting* version's notes, fetched `no-cache` from the new
   deploy, so the old page shows what the new code does. One source per fact: the notes
   ship with the build that they describe; the notice never hard-codes them.
3. **Make the state visible and quiet.** "Update ready" is inline status at a stable
   place in the app (see `interaction-feedback.md`), not a blocking modal and not a
   toast that disappears. Dismissing it hides it for this session; it comes back on the
   next launch until the person updates.
4. **Confirm after.** After the reload, show once which version is now running and its
   notes, so the person can connect a new behaviour to the update they chose.
5. **Gate live work.** The Update button refuses or defers while something irreplaceable
   is in progress (a recording, an unsaved draft, an upload) and says why. The gate must
   hold in every open window, not just the tapping one; see
   [service-worker updates with live drafts](pwa-specifics.md#service-worker-updates-with-live-drafts)
   and `browser-verification`'s `references/pwa-updates.md` for the two-tab proof.
6. **One owner.** The PWA alone decides when new code applies. A native shell around it
   never reloads to apply an update (`pwa-native-shell` I1, I2).

**The one exception** is a version that is broken or unsafe to keep running. Even then
the app tells the person what happened and why it is updating, and still waits for live
work to be saved first.

### Offer only a content-backed release

The waiting worker's existence, a completed update check, or a details-request retry does
not establish that a useful update is ready to offer. Resolve the stable identity of the
waiting release and load its actual, accurate user-facing notes first; unavailable,
loading, failed, or empty details mean no offer, and generic invented filler such as
"Fixes and speed improvements" cannot stand in for release content. If the release has
no meaningful note for the person, do not show an offer. Keep detail-fetch transport
state separate from offer visibility: retries and transient failures must not clear and
recreate an already content-backed offer. Bind dismissal to that release identity for
the current session so a retry or repaint cannot bring back the same dismissed offer;
a different identified release with its own notes is a new offer. This narrows only
which releases are shown; the explicit Update tap, reload ownership, and live-work guard
above remain unchanged.

Tejas reported the offer returning without anything useful to show on 2026-10-23 at
11:40 AM Eastern: "If there is no fucking thing to show. Why does it show up?" The
retained page record moved from update details `unavailable` with count 0 to `ready`
with count 1, 24 seconds later. The attached screenshot 10 seconds after the empty
response shows the visible update banner with a "What's new:" heading and no detail;
the page did not log offer visibility transitions.
Source: capture `16f2d253a9a01235669ea269b0d28f2a128e0f62e32dfa630b45a7a10d0bef43`,
request `fc78fdcd` (2026-10-23).

**Regression:** drive release details through `unavailable → loading → ready`, first with
empty details and then with a real note. Assert no offer while unavailable, loading, or
empty; show it only after the identified release's actual notes arrive. Dismiss it, repeat
the fetch/retry and transient-unavailable path in the same session, and assert that the
same offer stays dismissed; then supply a different release identity and assert its own
notes can be offered.

### Check

- `grep -rnE "skipWaiting|autoUpdate|controllerchange|clients\.claim"` over the app and
  worker: every `skipWaiting` call runs only from the Update button's message handler;
  every reload on `controllerchange` is guarded by "this window asked for it".
- Deploy two distinct builds. With the old one open: the notice appears, shows the new
  build's notes, and nothing reloads until Update is tapped; after the tap, the running
  version and its notes are shown once.
