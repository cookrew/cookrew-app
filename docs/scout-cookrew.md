# Cookrew — Scout Report

*Gap analysis of Cookrew (open-source Maestri clone) vs. Maestri and AgentGrid.*
*Prepared by Cookrew-Scout · 2026-07-19 · verified hands-on against the running app.*

---

## 1. Overview & Tech Stack

**Cookrew** is an open-source, cross-platform reimplementation of [Maestri](https://www.themaestri.app) — a *spatial workspace for AI agents*. The core idea, faithfully reproduced: terminals, sticky notes, and live browser portals live together on an infinite canvas, wired with rope cables, and **every connected agent gets a `cookrew` CLI** to talk to its neighbors, read/write notes, drive portals, recruit teammates, and schedule routines.

The defining design decision (inherited from Maestri and honored here): **the CLI *is* the entire agent API**, and **connectivity *is* authorization** — an agent can only see and touch nodes that are physically wired to its terminal on the canvas.

### Stack

| Layer | Technology |
|---|---|
| Shell | **Electron** (cross-platform — the key differentiator; Maestri is native Swift/AppKit, macOS-only) |
| Renderer | **React + @xyflow/react** (React Flow) infinite canvas; custom node types + `RopeEdge` |
| Terminals | **node-pty** real PTYs, rendered with **xterm.js**; a **`@xterm/headless`** mirror in the main process |
| Agent API | **Unix domain socket**, newline-delimited JSON; CLI is `cli/cookrew.mjs` (2.7 KB), copied next to the socket and injected onto every PTY's `PATH` |
| Portals | Electron **`<webview>`** with injected snapshot/automation JS (`portal-engine.ts`) |
| Mobile | LAN **HTTP + HTTPS** servers (self-signed cert via `cert.ts`) serving a single-file phone client |
| Voice | macOS **`say`** engine (out); browser **Web Speech API** (dictation, on phone) |
| Persistence | Plain JSON + real `.md` files under `~/.cookrew/` |

### Architecture (main-process authority)

```
Electron main
├─ WorkspaceStore    source of truth → ~/.cookrew/workspace.json + notes/*.md
├─ PtyManager        node-pty sessions + headless-xterm mirrors (for check/ask)
├─ ask engine        prompt → PTY, quiescence detection, output diff
├─ RoutineScheduler  cron-lite (--every / --daily), 15s tick
├─ VoiceEngine       macOS `say`
├─ Mobile server     LAN HTTP/HTTPS + phone client
└─ Socket server     Unix socket = the cookrew CLI backend
        │  IPC (portal commands forwarded to renderer)
   Renderer: React Flow canvas · TerminalNode · NoteNode · PortalNode (webview + snapshot engine) · RopeEdge
```

Code is clean, small, and well-organized: ~10 focused main-process modules, immutable store mutations, no obvious dead code. This is a **real, working application**, not a mockup.

---

## 2. Full Capability List (what actually works — verified live)

I exercised the running app through the injected CLI. **Every command below was confirmed working hands-on**, not just read in source.

### Canvas
- Infinite dark dotted-grid canvas, pan/zoom, **minimap**, React Flow **Controls**, `fitView`.
- Three node kinds: **terminal**, **note**, **portal**; drag via header handle, resize, delete (Backspace/Delete).
- **Rope cables** (dashed `RopeEdge`) between any nodes; connect via toolbar tool or drag-handle.
- Toolbar with tool modes (select / terminal / note / portal / connect) + preset picker strip + **Maestro** checkbox.
- Workspace fully **persisted & restored** on launch from `~/.cookrew/workspace.json`.

### Terminals
- Real PTYs (node-pty) spawned via login shell; xterm.js render in renderer, headless mirror in main.
- **Presets**: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), Shell. *(verified: `cookrew preset list`)*
- **Maestro flag** gates privileged verbs.
- Env injected into every terminal: `COOKREW_TERMINAL_ID`, `COOKREW_SOCKET`, `COOKREW_CLI`, `PATH` (CLI prepended), `TERM_PROGRAM=Cookrew`.

### The `cookrew` CLI (all verified against the live socket)

| Command | Status | Notes |
|---|---|---|
| `cookrew help` | ✅ | Full usage text |
| `cookrew list` | ✅ | Showed me: self (Conductor, maestro:true), agents Sherpa/Pilot, 4 portals, 1 note |
| `cookrew ask "Agent" "prompt"` | ✅ | Writes prompt to target PTY, blocks on **output quiescence**, returns the diff |
| `cookrew ask "Agent" --raw "\n"` | ✅ | Raw byte injection (`\n \t \e \xNN` decoded) |
| `cookrew check "Agent"` | ✅ | Returned Sherpa's live viewport (`➜ ~`) |
| `cookrew note create/read/write/edit/delete` | ✅ | Read the live E2E note; line-numbered output, substring edit, lock respect |
| `cookrew portal create/snapshot/click/fill/type/key/navigate/screenshot/evaluate/scroll/text/html/info` | ✅ | **See below** |
| `cookrew connect "From" "To"` | ✅ (Maestro) | Wire nodes from CLI |
| `cookrew recruit "Name" [--preset --role --dir]` | ✅ (Maestro) | Spawns a new terminal + PTY, auto-positions, auto-connects |
| `cookrew dismiss "Name"` | ✅ (Maestro) | Kills PTY + removes node |
| `cookrew preset list` | ✅ | 4 presets |
| `cookrew routine create/list/run/enable/disable/delete` | ✅ (Maestro) | `--every 30m` / `--daily 09:00`; live list showed empty state correctly |
| `cookrew voice on/off/status/list/set/rate/say` | ✅ | status: off, Samantha; `voice list` enumerated macOS voices |
| `cookrew mobile` | ✅ | Printed 7 LAN HTTPS URLs + guidance |
| `cookrew notify "msg"` | ✅ (Maestro) | Desktop notification |
| `cookrew app-shot` / `cookrew ui` | ✅ | Debug helpers (window capture / input injection) — used to produce the report screenshots |

### Portal automation — verified end-to-end
Against portal **"BTest"** (`localhost:8777/browsertest.html`):
- `cookrew portal snapshot "BTest"` → returned tagged refs: `@e1 h1 "Cookrew Browser Test"`, `@e2 input`, `@e3 button "Greet"`, `@e5 select`, checkbox, etc., **each with bounding box `[x,y wxh]`**.
- `cookrew portal fill "BTest" "@e2" "ScoutBot"` → **Filled**
- `cookrew portal click "BTest" "@e3"` → **Clicked**
- `cookrew portal info "BTest"` → title now **`greeted-ScoutBot`** ✅ — the page actually reacted. Real DOM automation, not simulated.

Selector engine supports `@eN` refs, raw CSS selectors, and `x,y` point coordinates. Each portal is an isolated webview session.

### ask engine (the crown jewel of fidelity)
`askTerminal` writes the prompt + `\r`, then polls: waits `graceMs` (1.5s) minimum, considers the agent "done" after `quiescenceMs` (2.5s) of output silence, caps at a 10-min timeout, then **diffs before/after scrollback** (longest-prefix-overlap to survive redraws) and returns only the newly produced text. This is a genuinely faithful clone of `maestri ask`'s blocking semantics — and it's what makes agent-to-agent delegation work without any SDK.

### Voice (AgentGrid-inspired)
- `cookrew voice on` → completed `ask` replies are spoken via macOS `say` (`speakReply` trims to 280 chars: "*{Agent} finished. {gist}*").
- Voice/rate configurable, persisted to `~/.cookrew/voice.json`. macOS-only for output.

### Mobile companion (AgentGrid-inspired)
- `cookrew mobile` prints LAN URLs (HTTPS self-signed so the phone gets a secure context for mic access).
- Phone client (single HTML file) lists terminals, tails output (`/api/terminal/:id/output`, polled), sends prompts or blocking asks, dictation + spoken replies via **browser Web Speech API**.

---

## 3. Standout Features

1. **True functional fidelity to Maestri's core loop.** The `ask` quiescence-and-diff engine, connectivity-as-authorization, Maestro-gating, and note auto-rename-from-first-line are all faithfully reproduced — not approximated. The CLI output formats mirror the real `maestri` CLI (which the author reverse-engineered from *inside* a real Maestri terminal).

2. **Cross-platform via Electron.** Maestri is native Swift/AppKit, macOS-only. Cookrew trades native polish for reach — the single biggest strategic differentiator.

3. **Portal automation with a token-efficient snapshot format.** `@eN tag "text" [x,y wxh]` refs are LLM-friendly and stable within a snapshot; the same idea as Maestri's portal refs, and comparable to accessibility-tree browser tools. Verified to actually drive a page.

4. **Zero-SDK agent model.** Any agent that can run a shell command can participate — just a binary on `PATH` speaking JSON over a socket. This is elegant and correct.

5. **Both AgentGrid signature features present**: voice mode (agents talk back) *and* a no-install mobile companion. Cookrew reaches past Maestri parity toward AgentGrid on these two axes.

6. **Genuinely small, readable codebase.** ~10 tight modules, immutable store, comprehensive error handling, clean IPC boundary. Easy to extend.

---

## 4. What is MISSING vs. Maestri & AgentGrid

The README's own roadmap is honest; this expands it with severity. Everything here is **not implemented** (verified: no code paths, no stubs beyond the model).

### vs. Maestri

| Missing capability | Severity | Detail |
|---|---|---|
| **Floors** (git/APFS-isolated per-branch working trees) | 🔴 High | Maestri gives each agent an isolated worktree/clone so parallel agents don't clobber each other. Cookrew has a single flat workspace; `recruit --dir` only picks a cwd. No isolation, no per-branch trees. README suggests git worktrees as the cross-platform path — unbuilt. |
| **Roles** (`role.json` presets injected as recruit context) | 🟠 Med | The data model has a `role: string \| null` field and `recruit --role` accepts a string, but **nothing consumes it** — no role library, no prompt injection, no `--replace` swap. It's a label only. |
| **Batuta** (command palette / global search) | 🟠 Med | No fuzzy command palette, no node search, no keyboard-driven navigation. |
| **Prompt composer** | 🟠 Med | No structured multi-field prompt builder; prompts are raw strings via `ask` or the mobile textbox. |
| **File-tree nodes** | 🟠 Med | No filesystem browser node on the canvas. |
| **Environments** (SSH/Docker remote bridge) | 🔴 High | Maestri bridges to remote hosts (local Unix socket ↔ remote TCP :7433 + per-terminal tokens). Cookrew is **local-socket only** — no remote/containerized terminals, no token auth. |
| **Groups / tidy / auto-layout** | 🟢 Low | No node grouping, no auto-arrange. Recruit uses naive offset positioning. |
| **Ombro** (local-model companion) | 🟠 Med | No bundled/local LLM companion. |
| **Native terminal polish** | 🟢 Low | xterm.js vs. SwiftTerm; no Sparkle-style auto-update, no native menu integration. |

### vs. AgentGrid

| Missing capability | Severity | Detail |
|---|---|---|
| **Cross-device / cloud sync** | 🔴 High | The mobile client is a **thin LAN remote** into the one running desktop instance — not sync. No account, no cloud state, no multi-device convergence, no offline. If the Mac is off or off-Wi-Fi, the phone has nothing. |
| **Persistent mobile app** | 🟢 Low | Browser-only (by design); no installable native app, no push. |
| **Voice on non-macOS** | 🟠 Med | Spoken output is hardcoded to macOS `say`; Linux/Windows get "unsupported". |
| **Multi-user / collaboration** | 🟠 Med | Single local user; no shared canvases, presence, or permissions beyond the Maestro flag. |

### Security / hardening gaps (not roadmap, but worth flagging)
- **No auth on the mobile server** — any device on the LAN can hit `/api/terminal/:id/input` and inject shell commands into any PTY. CORS is `*`. This is a real remote-code-execution surface on an untrusted network.
- **Self-signed cert only**; no per-terminal tokens (the very thing Maestri's environment bridge uses).
- `portal evaluate` runs arbitrary JS in the webview (expected for automation, but unsandboxed).

---

## 5. Honest Maturity Assessment

**Verdict: an impressive, genuinely working MVP — a faithful clone of Maestri's *core loop*, roughly a well-executed weekend-to-week build. It is real software that does what it claims, not a demo shell.**

**Strengths**
- The hard part — real PTYs, a headless mirror, quiescence-based `ask`, socket CLI, working portal automation — is **done and verified end-to-end**. I drove terminals, notes, and a live portal through the CLI and everything responded correctly.
- Architecture is clean and extensible; the store/IPC/socket boundaries are the right ones.
- Documentation (README + build report) is honest about what's unbuilt.

**Limitations / maturity ceiling**
- It clones Maestri's **single-canvas, single-machine, local core** but stops short of everything that makes Maestri a *product* rather than a *canvas*: **floors (isolation), roles, environments (remote), and Batuta** are all absent. Roles are modeled but inert.
- Against **AgentGrid**, the two headline features (voice, mobile) are present in spirit, but **true cross-device sync is not** — the mobile piece is a LAN remote, not a synced client.
- **Platform coupling**: voice output and (implicitly) the workflow assume macOS despite the "cross-platform" pitch; the Electron shell is cross-platform but voice, `say`, and the `-l` login-shell assumptions lean macOS.
- **Security is MVP-grade**: an unauthenticated LAN command-injection surface would block any real multi-user or untrusted-network use.
- No tests were run here, though `npm test` (vitest) exists and the README references an E2E verification pass; test coverage depth is unverified.

**Maturity rating: ~6/10** — *solid proof-of-concept / early alpha.* The foundation is strong enough to build the roadmap on, and the core agent-orchestration loop is production-*shaped*. But the isolation, remote, role, and sync layers that separate a "canvas of terminals" from "Maestri/AgentGrid" are the remaining ~40% and are the hard, differentiating 40%.

**If prioritizing next:** (1) **Floors via git worktrees** (biggest Maestri gap, cross-platform, README-endorsed), (2) **wire up roles** (model already exists — cheap win), (3) **auth on the mobile/socket surface** (unblocks everything remote/multi-user), (4) **environments bridge** (the remote-TCP+token architecture is already documented from the reverse-engineering).

---

*Sources: `/Users/drej/workspace/cookrew/README.md`, `docs/cookrew-report.html`, full `src/` read (main + renderer), and live CLI exercise against the running app (socket `cookrew-ffc`, terminal Conductor).*
