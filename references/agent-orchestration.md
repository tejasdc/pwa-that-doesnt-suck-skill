# Agent orchestration

*Load before dispatching Codex or a subagent, or when running multiple agents on the same repo. This encodes the process discipline that prevents silent progress loss, cross-agent path collisions, and shipping-without-looking.*

## Codex CLI — the deterministic pattern

Codex reviews and long-running codex implementation sessions are dispatched via the `codex exec` CLI, NOT the MCP integration. The MCP is buggy and unreliable in practice.

### Fresh session

```bash
# Short prompt inline:
codex exec --full-auto "PROMPT HERE" 2>&1 | tee tmp/reviews/<purpose>.run.log

# Long prompt (>~1KB) — write to file, pipe in:
cat /tmp/codex-<purpose>.txt | codex exec --full-auto 2>&1 | tee tmp/reviews/<purpose>.run.log
```

**Invoke with `run_in_background: true` on the Bash tool. DO NOT wrap in `nohup` or append `&`.** The Bash tool tracks the child; `nohup ... &` detaches codex and the completion notification fires for the wrapper (~10s) instead of the real 10-30 min codex run.

Flags:
- `--full-auto` = sandbox=workspace-write + approval=never. Default for iteration.
- `-s read-only` for pure review / analysis work that must not modify files (also hook-exempt for the `[GOALS-ONLY]` marker check).
- `--dangerously-bypass-approvals-and-sandbox` for implementation work needing full access (network, DerivedData writes, etc.) — this flag is the ONE that works on `resume` (`--sandbox` is rejected on resume).
- `--skip-git-repo-check` when cwd is outside a git repo.

Always tee to `tmp/reviews/<purpose>.run.log` so the run survives even if the Bash `.output` capture drops (~70% failure rate documented in issue #17011).

### Resume by explicit UUID — NEVER `--last`

`resume --last` is a race against every other codex run on the machine. Silent failures land the follow-up prompt in the wrong conversation.

Capture the UUID at dispatch:
```bash
# After dispatch, extract:
grep -oE "session id: [0-9a-f-]+" tmp/reviews/<name>.run.log | head -1 | awk '{print $3}'
```

Resume:
```bash
codex exec resume <UUID> --full-auto "FOLLOW-UP PROMPT" 2>&1 | tee tmp/reviews/<name>-resume.run.log
# Or for full-access resume:
codex exec resume <UUID> --dangerously-bypass-approvals-and-sandbox "..." 2>&1 | tee tmp/reviews/<name>-resume.run.log
```

Verify the resume landed on the right session AND actually ran:
```bash
echo "prior:   $(grep -oE 'session id: [0-9a-f-]+' tmp/reviews/<original>.run.log | head -1)"
echo "resume:  $(grep -oE 'session id: [0-9a-f-]+' tmp/reviews/<name>-resume.run.log | head -1)"
```
The UUIDs MUST match. If the resume log is empty within 10s, the codex process never spawned — often the goals-only hook blocking a missing `[GOALS-ONLY]` marker. Fix and redispatch.

### When to fresh vs resume

**Resume** ONLY when: pushing back or going deeper on the SAME design; prior reasoning is load-bearing for the follow-up.

**Fresh** for: a different fix, a different scoped task, a follow-up whose prompt stands on its own, parallel independent tasks, or when >30min have passed and prior context isn't load-bearing. Fresh costs a few seconds; resume costs a dropped ball if you're wrong about which session.

## Goals-only briefs

**Give Codex the GOAL and CONTEXT. Never prescribe files, lines, or implementation.**

Bad brief:
> Fix `src/worker.ts:912` — add `if (existing.status === "pending") return { challenge: existing }` before the create call, then update `src/main.tsx:2978` to check `home.sentChallenges`.

Good brief:
> Users report "the friend row still says Invite after I invite them" — the invitation state exists server-side but doesn't project to the surface. Codex: understand the current state model, identify the missing projection, and land a fix with a matching test. Also close any related gaps in `docs/state-machines.md` in the same PR.

**Why:** Codex discovers the codebase and picks the shape better than a prescribed plan. Your narrowing creates blinders; the model does a worse job under a specified implementation than under a specified goal.

Mark goals-only briefs with `[GOALS-ONLY]` at the top of the prompt if a hook is enforcing it.

## Long-running work — arm your own monitor

**Task notifications are a convenience, not a contract.** They CAN and DO break silently. Never depend on a notification arriving to resume work.

Any background work >5min needs a `ScheduleWakeup` armed by the dispatcher as a safety net:

1. Dispatch the codex / long agent in background.
2. Immediately arm `ScheduleWakeup` with `delaySeconds` matched to expected duration (e.g. 1200s = 20min for a typical 30-60min codex run).
3. The wakeup `prompt` MUST instruct the wakeup turn to:
   - `ps aux | grep <process-pattern>` — is it alive?
   - `tail -40 <run.log>` — is it making progress (new output since last check)?
   - `ls <expected-output-dir>` and `git log --oneline -5` — are artifacts landing?
   - Then act: re-arm if progressing, resume if dead, dispatch next step if done, escalate if stuck.
4. The wakeup MUST always re-arm itself with another `ScheduleWakeup` until the goal is met.
5. Match poll cadence to expected duration (20-30min for codex; 5-10min for shorter tasks). Don't poll aggressively; wasted turns cost tokens.

### The agent-spawns-codex parent-rest trap

If an agent dispatches a sub-codex or sub-bash in background, the agent's `task-notification` fires when the AGENT comes to rest — which happens BEFORE the child completes if the agent doesn't actively await it. Then the child finishes; nothing wakes the agent; parent (you) never gets a follow-up notification.

**Mitigation:** prefer dispatching codex DIRECTLY from your main session rather than through an agent layer. If a sub-agent must spawn codex, the sub-agent's prompt MUST instruct it to wait synchronously (poll its own child via `ps` in an until-loop) until the child completes — not "come to rest while waiting."

## One-owner-per-path (multi-agent runs)

When 2+ agents run in the same repo concurrently, each owns specific paths. Path collisions produce silent overwrites, mysteriously undone work, and lost commits.

Example ownership map:
- `prototypes/` — belongs to tumble-smith agent (rebuilding tumble animation). No other agent writes here.
- `src/` — belongs to chess-designer agent (the primary implementer).
- `tmp/reviews/icons/` — belongs to icon-round-2 agent.
- `docs/` — main session (team lead) only.

Rules:
1. **State the ownership map explicitly** in every agent's dispatch brief.
2. **When an agent notices its work about to touch a path outside its ownership**, it stops and messages the team lead.
3. **Stand-down orders** ("stop writing to X") require explicit acknowledgement in the agent's next message. A stand-down without ack is not registered.
4. **First rule of every agent write, all rounds:** `does this path belong to me?` If under someone else's path, no.

If an agent crosses the stand-down, the team lead: (a) reverts the offending commit, (b) confirms the ack in the agent's next reply, (c) restarts the offending agent with the corrected ownership map in the brief.

## Look at your own screenshots

**Every visual-change agent LOOKS at its rendered output before presenting.** Evidence assembled without being looked at is the named failure mode — a screenshot generated by playwright and put in a report is worthless if the agent never opened it.

For an agent, "look" = Read the PNG with the file-reading tool (which renders it inline), or open the contact sheet in `mcp__claude-in-chrome__computer` and screenshot it. Zoom to the size the user sees.

If the agent is presenting design work, side-by-side the render against the reference at the same zoom. This catches "child imitating art" — the most common failure of generative-design agents.

## Codex reviews are for a different model's perspective

Codex reviews exist because a different model catches different blind spots. A Claude agent doing "Codex-style" review defeats the purpose.

For a serious review: dispatch Codex with a goals-only brief that names the review target and the artifact to produce (`Write your review to /path/to/review.md`), let it run 20-60min, then integrate. Don't have Claude also perform the same review in parallel — you're paying twice for one perspective.

## Message-queue crossings — what survives compaction

**All agent output must be written to files, NEVER returned only via message.** Context compaction deletes message content — if a review only exists as a message reply, it's gone after compaction and the work is wasted.

Where things go:
- Reviews & analysis → `tmp/reviews/` (project-local, gitignored — survives session, not committed)
- Code → source files
- Plans & designs → `docs/plans/` (persistent, committed)

The parent agent reads the output file after; do NOT rely on the message return. After compaction the parent can re-read `tmp/reviews/` to recover findings.

Delete review files when the task is done — do NOT commit them to git.

## Commit cadence

Commit after every meaningful change. Don't wait for the user to ask. Every implementation, fix, or review iteration commits immediately. This overrides any default "only commit when asked" behavior.

Commit messages describe what changed and why (the surface, the state gap, the incident); never mention Claude or agent authorship.

## Sources

- The founding process discipline for this repo is in `~/.claude/CLAUDE.md` sections "Codex Reviews Must Use CLI", "Resuming a Codex session", "Codex Full-Access Flags", "Codex Timeout", "Long-Running Work", "Agent Execution Rules", and "Agent-to-Agent Communication Through Files". Re-read those sections in Tejas's global CLAUDE.md; they're the specific incidents that shaped these rules.
- The stand-down / one-owner-per-path pattern is drawn from the tumble-smith incident in this repo's session where an agent wrote to a locked path and had to revert.
