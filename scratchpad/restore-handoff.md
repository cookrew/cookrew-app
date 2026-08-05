# Restore / Rewind Executor — Handoff

## 1. What was built and where

### Backend executor + wiring (IN SCOPE)
- **`src/main/restore.ts`** (new)
  - `createRestoreHandlers({ store, ptys, traces, spawnTracked, projectsDir? })`
  - Implements `restoreCheckpoint(id, checkpointIndex)`:
    - Plans the cut with `planCheckpointRestore`.
    - Reads the bound Claude session file, truncates at the checkpoint uuid via `buildForkedSessionLinesAtUuid`, writes a **new** session file under a fresh id.
    - Kills the agent's tmux session with `ptys.killAndWait()`.
    - Rebinds the node to the new session id and pushes the previous session onto `node.restoreStack`.
    - Respawns with `spawnTracked()`.
  - Implements `undoRestore(id)`:
    - Pops the newest `RestorePoint` from `node.restoreStack`.
    - Verifies the previous session file still exists.
    - Kills, rebinds to the previous session id, removes the popped point, respawns.
  - Refuses honestly for non-Claude, missing session id, unknown checkpoint, missing source file, non-uuid checkpoint id, empty truncation result.

- **`src/shared/model.ts`**
  - Added `RestorePoint` type.
  - Added `restoreStack?: RestorePoint[]` to `TerminalNodeData`.

- **`src/main/restore-plan.ts`**
  - Removed local `RestorePoint` definition; now imports/re-exports it from `../shared/model`.
  - `pushRestorePoint` and `RESTORE_UNDO_CAP` unchanged.

- **`src/main/claude-fork.ts`**
  - Exported `claudeProjectDir` (was internal) so tests can locate temp project dirs.

- **`src/main/index.ts`**
  - Imports `createRestoreHandlers` and `RestoreResult`.
  - Instantiates handlers after `ptys.reloadTmuxConfig()`.
  - Passes `{ restoreCheckpoint, undoRestore }` to `registerIpc()`.
  - Passes `restoreCheckpoint` and `undoRestore` into `startMobileServer({ ... })`.

- **`src/main/mobile-server.ts`**
  - Added `restoreCheckpoint` and `undoRestore` to `MobileServerDeps`.

- **`src/preload/index.ts`**
  - No change — `agent:restore-checkpoint` / `agent:undo-restore` IPC channels were already exposed.

### Tests
- **`tests/restore-executor.test.ts`** (new)
  - 11 tests covering restore success, non-Claude refusal, missing session id, unknown checkpoint, missing source file, non-uuid checkpoint id, undo-stack cap, undo success, empty undo stack, missing previous file, and multi-point undo ordering.
- **`tests/restore-plan.test.ts`**
  - No logic change; still passes after `RestorePoint` moved to shared model.

### Explicitly NOT built (UI out of scope per Conductor)
- No `RESTORE` button in `CheckpointTimeline.tsx`.
- No `UNDO` button in `TerminalOverlay.tsx`.
- No toast helpers or icons.

## 2. Gap vs the brief: busy-agent refusal still owed

The brief requires that restore **refuse to run while the agent is mid-turn** (thinking/waiting/replied-but-not-idle) because truncating the session file while Claude Code is actively writing to it can tear the JSONL.

Current code only checks:
- Node exists and is a terminal.
- Harness is Claude with a bound session id.
- Checkpoint index / uuid / source file validity.

It does **not** inspect `TerminalActivity.phase` or `ptys.get(id)` state before killing and truncating. A restore issued during `thinking` or `waiting` may race the live Claude CLI and corrupt the origin session file (the new copy may also be inconsistent).

### Suggested fix
Before the kill/truncate in `restoreCheckpoint`, add a guard:

```ts
const activity = turns.activity(id) // or ptys.get(id) + phase lookup
if (activity && activity.phase !== 'idle') {
  return fail(id, node.name, checkpointIndex,
    `Agent is ${activity.phase} — wait for it to finish or acknowledge the turn before restoring.`)
}
```

The exact API to read live phase depends on the `TurnTracker` / `PtyManager` surface in `src/main/index.ts`. The guard should probably live inside `src/main/restore.ts` with `turns` passed as an optional dep, or the check can be done in `src/main/index.ts` before calling `restoreCheckpoint`.

## 3. Remaining live-probe steps

The running Cookrew app is the **old build**; it does not have the new `restoreCheckpoint` / `undoRestore` handlers, so the endpoints currently return `deps.restoreCheckpoint is not a function`. The app must be restarted by Conductor/user before this probe can complete.

Probe script: `/tmp/probe-restore.sh` (updated to fail on API errors)

Target terminal (chosen as sacrificial): **Beacon** `aacfb398-87c2-4987-b417-4c01f018b8b9`

Steps once the app is restarted on the new code:

1. Verify the mobile API is up:
   ```bash
   curl -s http://localhost:8639/api/state | python3 -m json.tool
   ```

2. Run the probe script:
   ```bash
   /tmp/probe-restore.sh
   ```

   The script performs:
   - Reads original `claudeSessionId` and computes the original session file path.
   - Records md5 of the original `.jsonl` file.
   - `POST /api/agents/aacfb398-87c2-4987-b417-4c01f018b8b9/restore` with `{checkpointIndex: 2}`.
   - Asserts the response has `ok: true`.
   - Polls `GET /api/state` until the terminal reports `running: true`.
   - Verifies the original session file md5 is unchanged.
   - Reads the post-restore `claudeSessionId` (should be a new uuid).
   - `POST /api/agents/aacfb398-87c2-4987-b417-4c01f018b8b9/restore/undo`.
   - Asserts the response has `ok: true`.
   - Polls `GET /api/state` until `running: true` again.
   - Asserts the post-undo `claudeSessionId` equals the original session id.

3. If the probe passes, the brief §4 verification is complete.

## Verification status
- ✅ `npx tsc --noEmit -p tsconfig.json`
- ✅ `npx tsc --noEmit -p tsconfig.node.json`
- ✅ `npx vitest run` — 860 passed, 3 skipped
- ⏸️ Live API probe — blocked until app restart

## Commands run during development
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.node.json
npx vitest run
```
