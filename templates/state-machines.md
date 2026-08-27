# {{APP NAME}} — state machines (audit + model)

*Owner: the state-machine architect role. Any change to state, transitions,
guards, or single writers must land here in the same commit as the code that
introduces it. This file is what every future agent reads to know the shape
of the system before touching it.*

## Status log

GAP-N identifiers are stable — do not renumber. Commit messages and test
names cite them (`state-smith GAP-N`). New gaps found in the audit are
appended at the next unused number.

- **{{COMMIT SHA}}** ({{DATE}}) — initial audit committed.
- (append here as gaps close)

## Vocabulary

- **State** — one of a finite, disjoint set of conditions an entity can be in.
- **Event** — the thing that fires (HTTP request, alarm, WebSocket frame, timer, deploy). Named for what happened.
- **Transition** — `(state, event) → state`, optionally with a guard.
- **Guard** — the precondition that must hold. If it fails, the event is rejected.
- **Single writer** — the ONE place in the codebase allowed to mutate an entity's state.
- **Projection** — a client-side view derived from the writer's state. Read-only.
- **Closure** — every state has an exit.
- **Representation** — the UI shape a state takes on every surface where the entity is user-relevant.

## Sources of truth

| Scope | Writer | Storage |
|---|---|---|
| {{ACCOUNT-SCOPED ENTITIES}} | `AppDO` (`ctx.storage.get("db")`) | Durable Object storage, single JSON blob keyed `"db"` |
| {{PER-ENTITY STATE}} | `{{PER-ENTITY DO}}` (`ctx.storage.get("state")`) | one DO per {{ID}} |
| {{IN-MEMORY DERIVATIONS}} | `{{DO NAME}}` (derived from `ctx.getWebSockets()` + `ctx.storage.get(...)`) | not persisted, computed at snapshot time |

Cloudflare Durable Objects serialize request execution per DO. Within a DO
handler there is no interleaving. That is what lets us treat each DO as a
lock-free single-writer without transactional bookkeeping.

## Machine inventory

1. Session / auth
2. {{RELATIONSHIP MACHINE — friendship, follow, membership}}
3. {{INVITATION MACHINE — challenge, ask-to-join}}
4. {{SCHEDULE / RECURRING MACHINE}}
5. {{PRIMARY DOMAIN OBJECT — game, session, document}}
6. Per-participant connection state
7. Push subscription

Presence, toasts, ephemeral UI widgets carry state but are not full
machines — describe them in "Non-machines" at the end.

---

## Machine 1 — {{MACHINE NAME}}

### Purpose
{{One sentence stating what this machine coordinates.}}

### States

- `{{state-1}}` — {{when this state holds}}.
- `{{state-2}}` — {{when this state holds}}.
- `{{terminal-state}}` — {{terminal condition; how it was reached}}.

### Events

- `{{event-name}}` — {{trigger}}. Guards: {{preconditions}}. Effects: {{what it changes}}.
- `{{event-name}}` — ...

### Transitions

```mermaid
stateDiagram-v2
  [*] --> {{initial}}
  {{initial}} --> {{next}}: {{event}}
  {{next}} --> {{terminal}}: {{event}}
  {{terminal}} --> [*]
```

### Writer
{{Which DO owns writes. Cite the specific handler file:line.}}

### Representation
- `{{state-1}}` — {{UI shape, cited file:line}}.
- `{{state-2}}` — {{UI shape, cited file:line}}.

### Closure
- `{{state-1}}` — exitable via {{event}} (path A) or {{event}} (path B).
- `{{state-2}}` — terminal.

### Notes on soundness
{{Any subtle correctness note — race hazards, idempotency guards, TTL sweeps.}}

---

## Gaps — ranked by user impact

### GAP-1 (P0 / P1 / P2 / P3 / P4): {{One-line description}}

**Where:** {{file:line or subsystem}}.
**What:** {{The specific defect — a missing state, an unreachable transition, a projection that isn't wired up}}.
**User impact:** {{What a user sees or fails to see because of this}}.
**Fix:** {{The specific change that closes the gap}}. Estimated effort: {{small / medium / large}}.
**Closed:** {{commit SHA + date, once the fix lands}}.

---

## What's next

{{TIER A / TIER B breakdown of remaining gaps, or "all closed" if the audit
is at rest. Every named machine should have: single writer, reachable
states, exits from every non-terminal, projections on every surface where
the entity is user-relevant, and durable storage that survives DO
hibernation.}}
