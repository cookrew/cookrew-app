# Brief: Endpoint Restore Executor (finish the restore/rewind feature)

**Owner:** Forge · **Reviewer:** Conductor · **Date:** 2026-08-04
**Constraint:** do NOT commit. Conductor reviews before any commit.

---

## 1. Mission

The endpoint-restore feature ("rewind a live teammate in place to one of its
checkpoints") is ~60% built in the working tree. Your job: write the missing
**executor** and wire it, so `POST /api/agents/<id>/restore` and the desktop
IPC path actually work, with the running-flag guarantee proven live.

## 2. What already exists (do not rebuild — reuse)

| Piece | Where | Notes |
|---|---|---|
| Restore planner | `src/main/restore-plan.ts` | `planCheckpointRestore({command, sessionId, checkpointIndex, blocks})` → `{ok, reason?, cutoffUuid?}`. Pure, tested (10 tests). Explicit refusals; Claude-only; cuts ONLY on a real message uuid. |
| Undo stack | same file | `pushRestorePoint(stack, entry)` — immutable, newest-first, cap 10 (`RESTORE_UNDO_CAP`). `RestorePoint = {sessionId, at, fromIndex}`. |
| Checkpoint refs (ALL endpoints) | `src/main/trace.ts` → `TraceReader.checkpointRefs(terminalId)` | Returns `{index, id}[]` for every checkpoint in the session FILE, incl. pre-compact ones. This is the `blocks` input to the planner. |
| Truncation engine | `src/shared/claude-fork.ts` → `buildForkedSessionLinesAtUuid(lines, {newSessionId, cutoffUuid})` | Already powers fork + role-boot restore. Rewrites session ids AND restamps. |
| Session-file resolution | `src/main/claude-fork.ts` → `claudeSessionFile(cwd, sessionId)` | Path to the live session jsonl. |
| Kill-with-teardown-await | `src/main/pty.ts` → `PtyManager.killAndWait(terminalId, timeoutMs=5000)` | THE fix for the respawn race (`new-session -A` attaching to a dying session). **Currently has zero callers — the executor is its first.** |
| HTTP routes | `src/main/mobile-api.ts:564-590` | `POST /api/agents/<id>/restore` `{checkpointIndex}` and `POST /api/agents/<id>/restore/undo`. They call `deps.restoreCheckpoint` / `deps.undoRestore` — **which are undefined today** (this is why node typecheck is RED: `MobileServerDeps` lacks the two props). |
| Result type | `src/shared/model.ts` → `RestoreResult` | `{ok, id, name, checkpointIndex, reason?, sessionId?, previousSessionId?, undone?}`. |
| Renderer surface | `src/preload/index.ts`, `src/renderer/src/api.ts`, `remote-api.ts`, `demo-api.ts` | `restoreCheckpoint` / `undoRestore` declared; preload invokes `agent:restore-checkpoint` / `agent:undo-restore` — **IPC handlers not registered.** No `.tsx` callsite yet (UI button is out of scope, see §6). |

## 3. What you build

### 3a. `src/main/endpoint-restore.ts` (new module, ~150 lines)

Export a factory `createEndpointRestore(deps)` returning
`{ restoreCheckpoint(id, checkpointIndex), undoRestore(id) }`, matching the
`MobileApiDeps` signatures. Injected deps (keeps it unit-testable like
`recover-gate`): store, ptys, traces (`TraceReader`), spawn fn, clock.

**`restoreCheckpoint(id, checkpointIndex)` flow:**

1. `store.nodeAcrossWorkspaces(id)` → must be a terminal in the ACTIVE
   workspace; otherwise refuse (`{ok:false, reason}`) — restore is in-place on
   the live canvas.
2. Refuse while the agent is mid-turn (activity phase = thinking/busy, from
   the turn tracker) — killing mid-write risks a torn session file. Honest
   reason: "agent is working — restore when idle."
3. `blocks = await traces.checkpointRefs(id)`;
   `plan = planCheckpointRestore({command: node.command, sessionId: node.claudeSessionId, checkpointIndex, blocks})`.
   If `!plan.ok` → return the refusal verbatim.
4. Read the live session file (`claudeSessionFile(node.cwd, node.claudeSessionId)`);
   `buildForkedSessionLinesAtUuid(lines, {newSessionId: freshId, cutoffUuid: plan.cutoffUuid})`;
   write the copy into the node's OWN Claude project dir
   (`claudeProjectDir(node.cwd)`), filename `<freshId>.jsonl`.
   **Never mutate the original file** — undo depends on it.
5. Push `{sessionId: old, at: now, fromIndex: checkpointIndex}` onto the
   in-memory undo stack (`Map<agentId, RestorePoint[]>`, module-level; v1 is
   runtime-only, matching the renderer's session-scoped undo expectation).
6. `store.updateNodeUnsafe(id, {claudeSessionId: freshId})` — rebind BEFORE
   respawn so `spawnTracked`'s `resolveClaudeSessionId` sees the new file.
7. `await ptys.killAndWait(id)` **then** `spawnTracked({...node, claudeSessionId: freshId})`.
   This ordering is the running-flag fix: no race, and `ptys.get(id)` is
   re-registered so `/api/state` reports `running: true`.
8. Return `{ok:true, id, name, checkpointIndex, sessionId: freshId, previousSessionId: old}`.

**`undoRestore(id)` flow:** pop the stack; empty → honest refusal
(`ok:false, reason:'Nothing to undo.'`). Rebind to the popped `sessionId`
(its file still exists — the original was never touched), same
kill-wait→respawn, return `{...ok:true, undone:true, checkpointIndex: popped.fromIndex}`.

### 3b. Wiring in `src/main/index.ts`

- Construct the executor once (near `recoverAgent`) and pass
  `restoreCheckpoint` / `undoRestore` into the `startMobileServer({...})` deps
  (line ~934) — this is what turns the node typecheck green.
- Register `ipcMain.handle('agent:restore-checkpoint', ...)` and
  `ipcMain.handle('agent:undo-restore', ...)` in `registerIpc()` (line ~1051),
  mirroring `agent:recover`.

### 3c. Tests — `tests/endpoint-restore.test.ts` (new, TDD: write FIRST)

Unit-test the executor with injected fakes (no Electron, no real fs/tmux):
- happy path: rebinds to a fresh id, old id on undo stack, kill awaited BEFORE
  spawn (assert call order), spawn receives the new session id;
- refusals: unknown agent / cross-workspace node / busy agent / planner
  refusal (bad checkpoint index, non-uuid block id, codex harness, no session);
- undo: restores the previous session id, `undone:true`; empty stack refuses;
- original session file content never written (assert no write to its path).

## 4. Acceptance criteria (ALL required)

1. `npm run typecheck` — BOTH configs green (node is red today on the missing
   deps; your wiring must fix it without a cast-through-unknown cheat).
2. `npm test` — full suite green, incl. your new executor tests.
3. **Live probe** (the part that proves the running flag — Forge's earlier
   session observed "restore works but the node looks dead"; that must not
   happen):
   - create a sacrificial Claude terminal via the API, send it 2 prompts so it
     has ≥2 checkpoints;
   - `POST /api/agents/<id>/restore` `{checkpointIndex: 1}`;
   - assert: response `ok:true`, `sessionId != previousSessionId`;
     `GET /api/state` shows the node `running: true`; the tmux pane is a LIVE
     claude on the truncated session (capture-pane shows a prompt, not a dead
     shell); the ORIGINAL session file still exists on disk;
   - `POST .../restore/undo` → rebinds to the original session id, still
     `running: true`;
   - then kill the sacrificial terminal and clean up its tmux session.
4. Report evidence (commands + observed outputs) — no "it should work".

## 5. Style / hard rules

- Immutability (no object mutation), small focused functions, match the
  comment style of `restore-plan.ts` (the "why", not the "what").
- Reuse `buildForkedSessionLinesAtUuid` / `claudeSessionFile` /
  `claudeProjectDir` — do not re-implement truncation or path logic.
- Never cut on a non-uuid, never touch the original session file, never spawn
  before the kill is confirmed dead.
- Codex/Pi/Shell restore stays honestly refused (planner already does this) —
  don't scope-creep into rollout truncation.

## 6. Out of scope

- Renderer UI button (CheckpointTimeline RESTORE affordance) — separate task
  after this lands.
- Persisting the undo stack across app restarts (v1 is in-memory).
- Voice-gateway work (separate project).

## 7. First reply

Start by replying with your implementation plan (5–10 lines) BEFORE writing
code — Conductor will sanity-check the approach in-thread. Then TDD.
