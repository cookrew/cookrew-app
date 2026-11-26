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

1. **One catalog id** in `src/shared/harness-catalog.ts` (`HARNESS_IDS`, name, bin, preset pattern), and **one registry entry** in `src/main/harness.ts`: `matches`, `bind` (strategy), `sessionField`, `resumeKey` (validating), `resumeCommand`, `stripSessionFlags`, the declared `turns` capability, and — when `'file'` — `parseTurns` + `watchFile` + `traceParser`. Then fill every per-harness feature table (rule 9): TypeScript lists each one you have not filled.
2. **Parsers live in `src/shared/trace-blocks.ts`** and are pure: `parse<Harness>Trace(lines) → TraceBlock[]`. Turn history is `turnRecordsOf(parse<Harness>Trace(lines))` — add `parse<Harness>Turns` as exactly that composition. No independent turn parser.
3. **Session files are discovered deterministically**: an exclusive per-terminal directory (Pi's `--session-dir` pattern) or lsof of the pane pid (codex/opencode pattern). Discovery by directory mtime is forbidden. Bind polls never give up: after the fast spawn schedule, a slow tail (`BIND_RETRY_TAIL_MS`) retries until the bind lands or the terminal goes away.
4. **Watch, trace and bind wiring is automatic**: `TraceReader.watchSpec`, the trace drawer/index/page (`TraceReader.transcriptOf`) and the CHAT/LOG chain (`streamChainOf`) all read `watchFile` + `parseTurns`/`traceParser` off the harness entry, so the drawer and the rail can never name different files. `spawnTracked` resumes and binds by the entry's `bind` strategy (`minted` · `pid-held` · `exclusive-dir`), never by its name; `pid-held` is generic (any harness that names an lsof resolver gets binding + resume), `minted` and `exclusive-dir` are Claude's and Pi's own code and the matrix test pins them to those harnesses until generalized. A conforming harness needs NO new call sites — if you find yourself editing `index.ts`, `trace.ts` or `stream-service.ts` to make history or resume appear, the registry entry is incomplete.
5. **Security invariants** (all pinned by tests): session ids/refs validated before touching paths or shell strings; each harness's `watchFile` resolver carries its own defense-in-depth check (claude UUID shape, codex sessions-tree prefix, pi exclusive-dir + header/cwd agreement); store writes go through the `updateNode` allow-list.
6. **Turn identity is session-namespaced**: a `TurnRecord.uuid` must be unique per SESSION, never positional-only — codex block ids are `<session_id>:p<ordinal>` because a bare `p<N>` collides across sessions and silently defeats the uuid title-carryover guard in `TurnTracker.replaceHistory`.
7. **Small files, immutable updates** per repo style; parsers are pure functions of `string[]`.
8. **Bind against the LIVE pane, not the command we would build today.** tmux `new-session -A` reattaches an existing session and silently ignores the launch command, so a pane created before a binding scheme existed keeps running the old one forever — a stored/derived command describes an intention, `#{pane_start_command}` + `#{session_created}` (`PtyManager.paneLaunch`) describe reality. When a harness locates sessions by a launch FLAG (pi's `--session-dir`), read that flag off the live pane; when the pane declares none, its session sits in the harness's shared default directory, and adopting from there stays deterministic only under two proofs: the session's own start timestamp inside the pane's start window (`PI_PANE_WINDOW_MS`) and the 1:1 ownership check against every other terminal. No pane start time = no adoption. The matching resume path must then resume the session **where it actually lives**, and every consumer — resume (`piLaunchBinding`, the registry's `resumeCommand`), watch, trace, and the recover EXACT-CONTEXT gate — must read that location from ONE resolver (`piSessionHome`); when they disagree, the rail fills while the trace drawer stays blank and recover refuses to spawn the very nodes adoption repaired. Adoption proofs, in order: the window is **forward-only** (a session already running when the pane booted belongs to someone else), tight (`PI_PANE_WINDOW_MS`), the winner is the session that opened **nearest** the pane start (mtime would hand a quiet pane's session to whoever typed last), and the id must be unclaimed by every other terminal. *Declared limitation:* if a legacy pane's agent switches sessions mid-life, adoption stays on the session that opened with the pane — a shared directory offers no honest way to follow the switch, and a wrong follow is worse than a stale-but-true binding.

9. **Every per-harness feature is one table keyed by every HarnessId** (`src/shared/harness-support.ts`: `PerHarness<T>` = implementation or `unsupported('reason')`; or `Record<HarnessId, T>` where every harness must have one). No `default`, no optional key, no `isClaudeCommand(x) ? … : nothing`: the 2026-11-25 audit found three places where a new registry entry silently lost recover (it fell into OpenCode's gate), resume/binding (dispatched inside per-name `if`s), and the trace drawer + CHAT/LOG (hard-coded to three names). Optional features (first-boot prep, cwd repair, idle sleep, held-session fork, role copy, native fork, restore, lineage, route dial, route effort choices) are declared in `src/main/harness-features.ts` and asked with `harnessHas(feature, command)`; the reason of an `unsupported` entry is what the card says when it refuses. The tables today: registry, catalog, `EXACT_RESTORE` + `SESSION_ON_DISK` (recover-gate), `HARNESS_INPUT` (composer + submit key), `SHARED_MCP_ARGS`, `OWN_ENDPOINT`, `LAUNCH_OFFERS`, `SESSION_CARRY`, install facts (`route/setup.ts`), `ROUTABLE`, `NOT_ROUTABLE_REASON`, `ROUTE_OVERRIDES`, `OWN_SUBSCRIPTION`, `OPTIONAL_FEATURES`, and `FOLLOW_BOUND_SESSION` (index.ts).

10. **Turn finality is declared, and a file proof is proven** (`TurnFinality` in `src/main/harness.ts`, `tests/harness-finality.test.ts`). `native`: the harness writes an end-of-turn record (claude `end_turn`, codex `task_complete`, pi `stopReason: 'stop'`). `structural`: it writes none, but the tail step being an assistant reply with no tool call is its loop's stop condition (Devin's `--export`, Antigravity's `transcript.jsonl`, both measured 2026-11-26); a structural claim also ships an APPROVAL_WAIT fixture proving a tail that holds a tool call waiting for the person stays open. `boundary`: only the next prompt closes a record, so file-backed background dispatch is refused. Dispatch acceptance asks `settlesFromFile(finality)`. **The live status is not a finality proof under herdr**: herdr strips OSC 7501 from the attach stream, and its Devin detector reported an approval wait as `done` (measured 2026-11-27, docs/osc7501-2026-11-26.html).

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
- **G7 reattach gate** — a live pane launched WITHOUT the harness's session flag still binds (from the shared dir, window + ownership proven), a pane that declares its dir never adopts a shared-dir decoy, adoption without a pane start time is refused, and an adopted session stays watchable at the watch boundary (`tests/pi-bind.test.ts`, `tests/session-watch.test.ts`). This is the gap that left the Playground Pi's rail reading `(recovered turn)` while its real history sat on disk.
- **G8 table gate** — every per-harness table has exactly the catalog ids as keys, at runtime too (a cast cannot hide one), and every `unsupported` carries a reason (`tests/harness-matrix.test.ts`).
- **G9 matrix gate** — which harness supports which optional feature and plumbing is PINNED; Claude keeps every optional feature; the route dial and R1 give the same not-routable reason; `traceParser` ⇔ `turns: 'file'`; `minted`/`exclusive-dir` stay with the harness whose code implements them.
- **G10 copy gate** — for every harness, `withoutSessionFlags(resumeCommand(cmd, key))` no longer names `key`: a fork, team copy or published template never resumes (and appends to) the source's session.

## 5. Current capability matrix

| Harness | Binding | Resume | Trace | Turn history | Restore |
|---|---|---|---|---|---|
| claude | minted/resolved id | `--resume <uuid>` | ✅ | ✅ file | ✅ |
| codex | lsof pane pid | `resume <uuid>` | ✅ | ✅ file | ❌ (honest refusal) |
| pi | exclusive `--session-dir`, or live-pane adoption (rule 8) | `--session <id>` in the dir that holds it | ✅ | ✅ file | ❌ (honest refusal) |
| opencode | lsof pane pid | `--session <id>` | ❌ | ⚠️ scrape (declared) | ❌ (honest refusal) |
| agy (Antigravity CLI) | lsof pane pid → `presence/<uuid>.lock` (from the first turn); follows `/clear` | `--conversation <uuid>` | ✅ | ✅ file, `structural` finality | ❌ (honest refusal) |

agy (2026-11-27) is the worked example of adding a harness after rule 9: one catalog id, one registry entry, a parser in `src/shared/agy-trace.ts`, `src/main/agy-bind.ts`, and one declaration per feature table — every one of them listed by the compiler. Not supported, with the reason on file: Magpie routing, the shared MCP hub, own endpoint, served seats, and the Claude-only features. Its folder trust and inline rendering ride on its launch line (`harness-launch.ts`, `--settings` for that session only). End-to-end proof: an isolated daemon drives a real agy card through boot, bind, a turn, an approval wait, a kill and resume, and `/clear`.

OpenCode reaching `'file'` = add `parseOpencodeTrace` (+ `parseOpencodeTurns` composition + `opencodeWatchFile`) and flip the two registry fields — no call-site edits anywhere else (rule 4).
