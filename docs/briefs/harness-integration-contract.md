# Harness Integration Contract

**Status:** permanent, enforced by `tests/harness-conformance.test.ts` (strict gate — do not weaken to land a harness).
**Trigger for this contract:** the Pi preset shipped with session binding, trace parsing, and recover support, but its **endpoint history (turn rail titles/prompts) never materialized** — `SessionTurnSync` reconciled only Claude session files, and Pi's PTY scrape yields no usable prompts. Codex had the same latent gap. Both are now file-derived; this contract makes the gap impossible for the next harness.

---

## 1. What "integrated" means

A harness is **integrated** when an agent running it gets the same user-visible features Claude Code agents get:

| Feature | Mechanism | Contract requirement |
|---|---|---|
| Session binding | `Harness.sessionField` + deterministic bind at spawn | **Deterministic only** (exclusive dir or lsof-of-pane-pid). Never an mtime/"most recent file" guess — that is the phantom-session / cross-wiring class (EXACT-CONTEXT gate). |
| Resume after death | `Harness.resumeKey` / `resumeCommand` | `resumeKey` MUST validate the stored ref against the harness's closed alphabet before it can reach a path or shell string. Node fields can arrive over the network; an unvalidated ref is an injection/path-traversal vector. |
| Trace blocks (checkpoint rail, rewind picker) | `parse<Harness>Trace` in `src/shared/trace-blocks.ts` | One block per real user prompt; `TraceBlock.index` is the harness's checkpoint ordinal. |
| **Endpoint history (turn titles/prompts)** | `Harness.parseTurns` + `SessionTurnSync.watch` | Every harness with a session file MUST declare `turns: 'file'` and wire `parseTurns`. `turns: 'scrape'` is a declared limitation, not an omission — the conformance suite fails on undeclared/mismatched capability. |
| Identity alignment | shared derivation | `TurnRecord.index === TraceBlock.index` on the same session lines, BY CONSTRUCTION: derive turn records FROM the trace blocks (`turnRecordsOf`), never from a second parser. A second parser is how the phantom-offset bug happened. |
| Recover gate | `recover-gate.ts` | The recover path must resolve the harness's resume key through `Harness.resumeKey` (validated), never raw string interpolation. |
| Restore/rewind | `restore.ts` | Claude-only today. A new harness documents restore support explicitly; unsupported must refuse honestly (the executor already does). |

## 2. Implementation rules (adding a harness)

1. **One registry entry** in `src/main/harness.ts`: `matches`, `sessionField`, `resumeKey` (validating), `resumeCommand`, the declared `turns` capability, and — when `'file'` — `parseTurns` + `watchFile`. That entry is the WHOLE integration; see rule 4.
2. **Parsers live in `src/shared/trace-blocks.ts`** and are pure: `parse<Harness>Trace(lines) → TraceBlock[]`. Turn history is `turnRecordsOf(parse<Harness>Trace(lines))` — add `parse<Harness>Turns` as exactly that composition. No independent turn parser.
3. **Session files are discovered deterministically**: an exclusive per-terminal directory (Pi's `--session-dir` pattern) or lsof of the pane pid (codex/opencode pattern). Discovery by directory mtime is forbidden. Bind polls never give up: after the fast spawn schedule, a slow tail (`BIND_RETRY_TAIL_MS`) retries until the bind lands or the terminal goes away.
4. **Watch wiring is automatic**: `TraceReader.watchSpec` is registry-driven — it reads `parseTurns`/`watchFile` off the harness entry; `spawnTracked` and every delayed-bind success path call `watchSessionTurns` unconditionally. A conforming harness needs NO new call sites and NO trace.ts edits — if you find yourself editing `index.ts` or `trace.ts` to make history appear, the registry entry is incomplete.
5. **Security invariants** (all pinned by tests): session ids/refs validated before touching paths or shell strings; each harness's `watchFile` resolver carries its own defense-in-depth check (claude UUID shape, codex sessions-tree prefix, pi exclusive-dir + header/cwd agreement); store writes go through the `updateNode` allow-list.
6. **Turn identity is session-namespaced**: a `TurnRecord.uuid` must be unique per SESSION, never positional-only — codex block ids are `<session_id>:p<ordinal>` because a bare `p<N>` collides across sessions and silently defeats the uuid title-carryover guard in `TurnTracker.replaceHistory`.
7. **Small files, immutable updates** per repo style; parsers are pure functions of `string[]`.

## 3. Conformance tests (run for every harness)

`tests/harness-conformance.test.ts` is the permanent gate:

- **Capability declared** — every registry entry has `turns: 'file' | 'scrape'`.
- **Capability ⇔ wiring** — `'file'` entries wire both `parseTurns` and `watchFile`; `'scrape'` entries wire neither (no silent half-support).
- **Baseline preserved** — claude, codex, pi are pinned at `'file'`. A regression here fails the suite.
- **Resume-key validation** — hostile refs (`../../etc/passwd`, `x; rm -rf /`, non-UUID) are rejected by every harness's `resumeKey`.
- **Identity alignment (phantom-offset gate)** — for each `'file'` harness, `parseTurns(lines).map(t => t.index)` equals `parse<Harness>Trace(lines).map(b => b.index)` on a shared inline fixture, and yields at least one turn.

Supporting suites: `tests/session-watch.test.ts` (TraceReader.watchSpec resolution per harness, incl. planted-ref refusal and unbound → null), `tests/pi-turns.test.ts` (pi/codex turn derivation, active-branch-only, index alignment), `tests/session-sync.test.ts` (parser-parameterized reconcile).

## 4. Eval gates (permanent, like the checkpoint-rail gates)

- **G1 capability gate** — no harness ships with an undeclared turn capability (conformance test 1–2).
- **G2 baseline gate** — claude/codex/pi never regress below `'file'` (test 3).
- **G3 identity gate** — turn/trace index alignment per harness (test 5). Same class as the F6 marker↔tag alignment gate: it has regressed before, it is load-bearing, it stays.
- **G4 injection gate** — resumeKey rejection of hostile refs (test 4).
- **G5 watch gate** — `watchSpec` returns null for unbound/scrape/plain-shell terminals and refuses out-of-tree refs and non-UUID claude ids (`tests/session-watch.test.ts`).
- **G6 identity-namespace gate** — codex turn uuids carry the rollout session id; two sessions never share a uuid (`tests/pi-turns.test.ts`).

## 5. Current capability matrix

| Harness | Binding | Resume | Trace | Turn history | Restore |
|---|---|---|---|---|---|
| claude | minted/resolved id | `--resume <uuid>` | ✅ | ✅ file | ✅ |
| codex | lsof pane pid | `resume <uuid>` | ✅ | ✅ file | ❌ (honest refusal) |
| pi | exclusive `--session-dir` | `--session <id>` | ✅ | ✅ file | ❌ (honest refusal) |
| opencode | lsof pane pid | `--session <id>` | ❌ | ⚠️ scrape (declared) | ❌ (honest refusal) |

OpenCode reaching `'file'` = add `parseOpencodeTrace` (+ `parseOpencodeTurns` composition + `opencodeWatchFile`) and flip the two registry fields — no call-site edits anywhere else (rule 4).
