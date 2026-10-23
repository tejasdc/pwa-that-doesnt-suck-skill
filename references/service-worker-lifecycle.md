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

### Offer only the downloaded release's own description

The waiting worker's existence, a completed update check, or a detail-fetch retry does
not establish that useful release details are ready. Resolve the description from the
source keyed to the exact downloaded worker revision. Do not make that content's
availability depend on a later activation record in the release-history ledger: during
the October 23 incident, the server's startup warm cache preceded the activation record,
so its first read returned old history even though the authored note already existed for
the downloaded release. The original successful response body was not retained, but the
timing and retained authored note identify this mismatch; a reproduction proved the
warm-cache ordering can return old history before the activation is recorded.

Keep the unknown-content UI guard separate from that root repair. If the exact revision
has no description, or its description is empty or only generic filler such as "Fixes
and speed improvements," ignore that content and show no offer. But do not call known
content unavailable merely because a later ledger has not caught up. Preserve the
requested revision, the revision actually answered, and the reason a description could
not be resolved so the mismatch can be diagnosed. Keep retry transport state separate
from offer visibility; a retry cannot create an offer or resurrect a dismissed one.
Bind dismissal to the downloaded revision for the current session. A different
identified revision with its own description is a new offer. The explicit Update tap,
reload ownership, and live-work guard above remain unchanged.

Tejas reported the empty update banner on 2026-10-23 at 11:40 AM Eastern: "If there is
no fucking thing to show. Why does it show up?" The retained page record moved from
details `unavailable`, count 0, to `ready`, count 1, 24 seconds later; a screenshot 10
seconds after the first response shows the banner with a blank "What's new:" area. The
first diagnosis treated this as an empty-offer presentation defect alone. Tejas corrected
the framing: "So the solution is not to prevent empty description from coming in the 1st
place, but to just ignore them." He also said, "you're not going to investigate too."
The concrete cause was a startup warm-cache read before the activation record existed;
the later activation ledger was incorrectly made the description source. The original
response body remains unretained. Source: capture
`16f2d253a9a01235669ea269b0d28f2a128e0f62e32dfa630b45a7a10d0bef43`, request
`fc78fdcd` (2026-10-23); reproduced warm-cache/late-activation ordering.

**Regression:** separately check (1) unknown, empty, and generic descriptions remain
ignored, including through `unavailable → loading → ready`, and cannot show or restore a
dismissed offer, and (2) a real description keyed to the downloaded revision remains
available when startup warm history predates its later activation record. Record both
the requested and answered revisions and the resolution reason; verify that the answer
uses the requested revision's description despite stale activation history. Then supply a
different downloaded revision and verify its own description is offered.

### Check

- `grep -rnE "skipWaiting|autoUpdate|controllerchange|clients\.claim"` over the app and
  worker: every `skipWaiting` call runs only from the Update button's message handler;
  every reload on `controllerchange` is guarded by "this window asked for it".
- Deploy two distinct builds. With the old one open: the notice appears, shows the new
  build's notes, and nothing reloads until Update is tapped; after the tap, the running
  version and its notes are shown once.
