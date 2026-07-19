# AG-Scout: Competitive Evaluation of Agent Grid 2.7.9

> Gap-analysis scouting report for Cookrew / Maestri. Compiled 2026-07-19 from first-hand
> inspection of the installed build (`/Applications/Agent Grid.app`, running), the
> official docs at `https://agentgrid.sh/docs`, the app bundle, and the on-disk data
> model at `~/Library/Application Support/agent-grid`. Every claim below is tagged with
> how it was observed: **[docs]**, **[bundle]**, **[UI]**, or **[data]**.

---

## 1. Overview & Tech Stack

**What it is.** Agent Grid bills itself as *"an infinite canvas desktop app for managing
multiple AI agent instances as panes you orchestrate."* **[docs]** It is a spatial,
Figma-like 2D workspace where each AI agent (Claude Code, Codex, Antigravity), terminal,
browser, editor, or note lives as a free-floating **pane** on a zoomable **canvas**. It
directly overlaps Maestri's and Cookrew's "canvas of agents" positioning.

**Tech stack — confirmed Electron, not native.** **[bundle]**
- `Contents/Frameworks/` contains `Electron Framework.framework`, plus `Squirrel.framework`,
  `Mantle.framework`, `ReactiveObjC.framework` (Squirrel auto-updater stack), and the four
  standard Electron helper apps (GPU / Plugin / Renderer / main). This is a **stock Electron
  app**, in contrast to Maestri's native-Swift build.
- `Info.plist`: `CFBundleIdentifier = sh.agentgrid.app`, `CFBundleShortVersionString = 2.7.9`,
  `NSPrincipalClass = AtomApplication` (Electron), category `public.app-category.developer-tools`,
  min macOS 12.0, built with Xcode 16.4 / macOS 15.5 SDK. `ElectronAsarIntegrity` present.
- **Renderer stack** (from `app.asar` strings): React (`react`, `react-dom`, with a bundled
  `react-17`/`react-dom-17` compat), **TipTap** rich-text editor (large extension set → the
  Note pane), **`@xterm/xterm` + `node-pty`** (terminals + CLI agent panes), a **Monaco/VS
  Code** editor pane, and a canvas renderer. **[bundle]**
- **Agent runtime**: `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` (SDK worker
  backend), `@modelcontextprotocol/sdk` (MCP client + the orchestration tool server). **[bundle]**
- **Backend/server**: `express`, `express-ws`, `express-session`, `express-rate-limit`,
  `qrcode` → an embedded HTTP/WebSocket server used for the **mobile bridge** and daemon. **[bundle]**
- **Auth**: `better-auth` (per changelog v2.6.4), Google Sign-In (v2.6.3). Local identity
  stored at `auth/identity.json` with an **encrypted** refresh token (`refreshTokenEnc`,
  versioned `v:2` envelope). API keys in `settings.json` are likewise encrypted
  (`openaiApiKeyEnc`). **[data]**
- **Voice**: OpenAI **Realtime API** (`gpt-4o-realtime`, `RealtimeSession`, `REALTIME_URL_BASE`),
  **Deepgram**, and **Whisper** strings all present in the bundle. **[bundle]**

**Providers enabled** (this install): `claude`, `codex`, `antigravity` — all three toggled on.
Worker backend defaulted to **`sdk`**; Claude permission mode set to **`bypassPermissions`**. **[data]**

---

## 2. Full Capability List

### Canvas & navigation **[docs][UI]**
- Infinite, unbounded 2D canvas; one canvas per space.
- Pan: hold **Space + drag**. Zoom: **Cmd/Ctrl + Scroll** (zoom under cursor),
  **Cmd/Ctrl + = / −**, **Cmd/Ctrl+Shift+2** to zoom-all-to-fit.
- **Minimap** (bottom-left) with live viewport rectangle + pane thumbnails — observed
  rendering 2 panes. **[UI]**
- Bottom-right HUD: **"2 instances · Reorg · Fit · 38%"** — live pane count, one-click
  **Reorg** (auto-organize into a grid preserving master/worker hierarchy), **Fit**, and
  zoom-percentage control. **[UI]**
- **Auto-Organize / Reorg**: redistributes scattered panes into an orderly grid while keeping
  master→worker grouping. **[docs][UI]**

### Spaces (tabs) **[docs][UI][data]**
- Each **space** = a title-bar tab with its own canvas, camera state, and exactly one bound
  project folder. **Cmd/Ctrl+T** for a new space. Observed tab labeled **`krew-dev`**. **[UI]**
- Same folder can be opened in multiple spaces simultaneously; a space points at one folder
  at a time. Rebinding mid-session only affects newly spawned panes.
- Recent-projects history for quick rebind (`recent-projects.json`), open-tabs persistence
  (`open-tabs.json` → currently `/Users/drej/workspace/krew-dev`, `location.kind: "local"`). **[data]**

### Workspace Explorer / search **[docs][UI]**
- Left sidebar ("WORKSPACE") lists every pane in the space; observed listing **Source Control**
  and **www.baidu.com** (a browser pane). **[UI]**
- **Cmd/Ctrl+\\** toggle sidebar; **Cmd/Ctrl+F** search panes by title/metadata; filter icon
  for active-pane filtering. **[docs][UI]**

### Pane types — 11 total **[docs]** (Cmd/Ctrl + 1–0)
| # | Type | Function |
|---|------|----------|
| 1 | **Claude Code** | Master-capable `claude` CLI session in a terminal |
| 2 | **Codex** | `codex` CLI session |
| 3 | **Antigravity** | `agy` CLI session |
| 4 | **Terminal** | Plain shell (xterm.js) |
| 5 | **Code Editor** | Embedded VS Code / Monaco |
| 6 | **Source Control** | Git staging / diff / commit (also **Ctrl+Shift+G**) |
| 7 | **Browser** | Chromium browser pane w/ DevTools |
| 8 | **Note** | TipTap markdown editor + **Whisper dictation** |
| 9 | **Title** | Decorative section header |
| 0 | **Insert Media** | Image / video panes |
- Two internal, non-user-spawnable worker types: `claude_worker`, `codex_worker`. **[docs]**
- Observed live: a **Source Control** pane (branch `main`, Changes/Log tabs, staged +
  untracked file list) and a **Browser** pane rendered on `https://www.baidu.com`. **[UI]**

### Pane management **[docs]**
- Spawn: spawn menu (**Cmd/Ctrl+N** or right-click), direct number shortcuts (spawn at
  cursor), drag-drop media, or master-spawned workers.
- Move (drag header), multi-select (Cmd+Click, Esc to clear), delete (Delete / Cmd+Backspace).
- **Undo/redo** (Cmd+Z / Cmd+Shift+Z) restores deleted panes **including Claude sessions with
  intact history**; undoing a master restores all its workers in one step.
- **Cmd+R** renames panes; pane duplication; auto-naming of agent panes.

### Agents, workers & orchestration **[docs][bundle]**
- **Master/worker model**: any Claude pane is "master-capable" and becomes a master on first
  MCP tool call. Masters are **canvas-blind by design** — a new master sees no panes until it
  explicitly calls `associate_pane({pane_id})`, then `read_pane`. **[docs]**
- MCP orchestration tools confirmed in bundle strings: **`spawn_worker`**, **`spawn_role`**,
  **`associate_pane`**, **`read_pane`**, **`list_recoverable_sessions`**. **[bundle]**
- **8 built-in roles**: builder, qa, validator, backend, frontend, devops, security,
  browser_qa — overridable/extendable via `.agent-grid/roles.json`. **[docs]**
- **Two worker backends**: **SDK** (Claude Agent SDK, does *not* consume Max quota — default)
  vs **PTY** (headless CLI through Max subscription). Precedence:
  `AGENT_GRID_WORKER_BACKEND` env → role `backend` → implicit SDK → settings default. **[docs][data]**
- **Worker streaming**: token-by-token output with visible thinking blocks + tool calls;
  interrupt-safe (no double-paint on resume). **[docs]**
- **Crash recovery**: each pane carries a `sessionId` → `claude --resume`; workers keep a
  `workerSessionId`; automatic session resumption after crash (v2.5.13). **[docs]**

### Voice mode **[docs][bundle]** *(standout — see §3)*
- Live voice calls "straight to the realtime model" (OpenAI Realtime / `gpt-4o-realtime`),
  with a **voice picker**, **call-history viewer**, **call logs + end-of-call summaries**,
  and **multilingual** support. Deepgram + Whisper also bundled. **[bundle][docs-changelog]**

### Mobile / cross-device **[docs][bundle][data]** *(standout — see §3)*
- **Mobile bridge**: an Electron-hosted, mobile-facing HTTP/WS server (express + express-ws)
  with device **pairing via QR code** (`qrcode`), token-hashed devices, and IPC admin
  (`mobile-devices:create/list/revoke/bridgeStatus`). **[bundle]**
- `mobile-devices.json` holds one paired device: `{deviceId, label:"Mobile device",
  tokenHash, kind:"mobile", revokedAt:null}`. **[data]**
- **iOS TestFlight** app (Round 2 shipped v2.5.15). **[docs-changelog]**
- **Cross-device project sync** (v2.6.0): panes, terminals, notes, titles, and layout stay
  in sync **both ways** across paired machines; folders marked "shared." **[docs-changelog]**

### System tray & background daemon **[docs]**
- Persistent menu-bar/tray icon; survives closing the main window.
- **Opt-in daemon** (`AGENT_GRID_DAEMON=1`) owns PTYs + worker child processes independently
  of the window — close or crash the app **without losing agents' work**. Status states:
  connected / connecting / running-but-disconnected / not running. `children.pids` +
  `masters.json` on disk track this. **[docs][data]**

### Platform & lifecycle **[docs-changelog][bundle]**
- macOS (Apple Silicon + **Intel native**, v2.7.1), **Windows & Linux** (v2.5.11).
- In-app auto-update (Squirrel) with session-aware install; in-app billing / usage limits;
  CLI-installation helper UI; Discord announcements.

---

## 3. Standout / Unique Features (vs Maestri & Cookrew)

1. **Voice mode with call history** — full realtime voice calls to the model, a voice
   picker, persistent **call logs + auto summaries**, multilingual. This is the most
   differentiated surface; neither a canvas terminal nor a note, but a telephony-style
   agent channel. **[bundle][docs]**
2. **True cross-device, two-way project sync** — not just remote access but live mirroring
   of panes/terminals/notes/layout across machines, plus a **native iOS TestFlight** client.
   Positions Agent Grid as multi-device, not desktop-only. **[docs]**
3. **Mobile bridge with QR pairing + token-hashed devices** — an embedded express/WS server
   turns the desktop into a host your phone controls; concrete on-disk evidence of a paired
   device. **[bundle][data]**
4. **Canvas-blind master/worker orchestration over MCP** — masters must *opt in* to seeing a
   pane (`associate_pane` → `read_pane`) before reading it; `spawn_worker` / `spawn_role`
   with 8 project-overridable roles. A deliberate, permissioned orchestration model rather
   than implicit shared vision. **[docs][bundle]**
5. **Dual worker backend (SDK vs PTY)** — SDK path explicitly *avoids consuming Max quota*,
   a pragmatic cost lever competitors rarely expose. **[docs][data]**
6. **Persistent background daemon** — agents keep running after the GUI closes or crashes;
   PTY/worker ownership is decoupled from the window. **[docs]**
7. **`.agent-grid/` as a source-controllable "contract"** — `notes/` (canonical note text),
   `notes-inbox/` (drop `.md` → auto-pane, polled every few seconds), `roles.json`,
   `qa-specs/` (browser_qa write area). External scripts can inject notes programmatically. **[docs]**
8. **browser_qa workers** — dedicated QA agents that drive the Chromium pane and write
   recordings / regression specs / findings into `qa-specs/`. **[docs]**
9. **Undo that restores whole agent subtrees** — undoing a master brings back all workers
   *and* their session history in one step. **[docs]**

---

## 4. Data Model & Storage

Root: `~/Library/Application Support/agent-grid` (standard Electron `userData`). **[data]**

| Path | Contents (observed) |
|------|---------------------|
| `settings.json` | Global prefs: `explorerWidth`, `claudePermissionMode:"bypassPermissions"`, `claudeWorkerBackend:"sdk"`, `providers[]` (claude/codex/antigravity, all enabled), `telemetryEnabled:true`, **`openaiApiKeyEnc`** (encrypted `v10…` envelope) |
| `auth/identity.json` | `{v:2, userId, email, refreshTokenEnc}` — encrypted refresh token; email = signed-in Google account |
| `masters.json` | Master-pane registry (currently `{}`) |
| `mobile-devices.json` | `{version:1, devices:[{deviceId, label, createdAt, tokenHash, kind:"mobile", revokedAt}]}` — one paired mobile device |
| `mcp-configs/` | Per-server MCP configs (empty this install) |
| `open-tabs.json` | Open spaces + active index → one local project `/Users/drej/workspace/krew-dev` |
| `recent-projects.json` | MRU folder list w/ `location.kind` (local vs shared) |
| `children.pids` | PIDs of daemon-owned child processes (empty = daemon off) |
| `usage-cache.json` | Provider quota windows: claude `five_hour` 13%, `weekly` 29%, `weekly_fable` 46%, each w/ `resetsAt` + `exhausted` — mirrors the "13% 5h" HUD chip **[UI]** |
| `telemetry-id.json` / `.updaterId` | Anonymous UUIDs |
| `IndexedDB/`, `Local Storage/`, `Session Storage/`, `Service Worker/`, `WebStorage/` | Chromium storage — canvas/pane state persisted here (IndexedDB keyed on `http_localhost_<port>`, i.e. a local renderer origin) |
| `Partitions/`, `Cookies`, `Cache`, `Code Cache`, `blob_storage` | Standard Chromium session state |

**Model shape (inferred):** a *space* binds one project folder + a camera; a *canvas* holds
*panes* (id, position, size, z-order, agentType); Claude panes carry `sessionId`, workers
carry `workerSessionId`; masters register in `masters.json`; per-project artifacts live in the
repo's own `.agent-grid/`. Secrets (API keys, refresh tokens) are **encrypted at rest** with a
versioned envelope; account identity is cloud-backed (Better Auth + Google). **[data][docs]**

---

## 5. UX & Notable Design Choices

- **Spatial-first, keyboard-driven.** Everything is a pane; Cmd+1–0 spawns instantly at the
  cursor. The experience is explicitly "Figma-like" and mirrors Maestri's canvas metaphor. **[docs][UI]**
- **Live orchestration HUD.** The bottom-right *instances · Reorg · Fit · %* cluster and the
  bottom-left minimap give constant spatial awareness at scale — a thoughtful answer to
  "canvas gets messy after a long session." **[UI]**
- **Quota transparency in-chrome.** A top-right usage chip ("13% 5h") surfaces the 5-hour
  window live, backed by `usage-cache.json`; billing/limits are managed in-app. **[UI][data]**
- **Safety framing on folder trust.** Observed first-run agent prompt: *"Quick safety check:
  Is this a project you created or one you trust?… 1. Yes, I trust this folder 2. No, exit"* —
  a Claude-Code-style trust gate surfaced inside the pane. **[UI]**
- **Permissioned agent vision.** Canvas-blind masters + explicit `associate_pane` is a
  deliberate least-privilege choice — agents don't silently read the whole canvas. **[docs]**
- **Git-native.** A first-class Source Control pane (branch, staged/untracked, commit box,
  Log tab) sits alongside agents, observed live on `main`. **[UI]**
- **Config-as-contract.** `.agent-grid/` is designed to be committed and shared; the
  `notes-inbox/` polling loop lets any external tool feed the canvas. **[docs]**
- **Resilience by default.** Undo restores agent subtrees w/ history; optional daemon keeps
  work alive past a GUI crash; automatic session resume. **[docs]**
- **Multi-provider + multi-device.** Claude/Codex/Antigravity side-by-side, SDK-vs-Max cost
  control, and a phone client that stays in sync — a broader surface than a single-agent CLI. **[docs][data]**

---

### Gap-analysis takeaways for Cookrew / Maestri
- **Where Agent Grid leads:** realtime **voice mode w/ call history**, **two-way cross-device
  sync + iOS TestFlight**, **daemon-backed persistence**, **SDK/PTY cost lever**, and a
  clean **permissioned MCP orchestration** contract (`spawn_role` + `.agent-grid/roles.json`).
- **Where it's beatable:** it's **Electron** (heavier, non-native — Maestri's native Swift is a
  differentiator), and `bypassPermissions` + a plaintext-adjacent local mobile bridge/token
  model is worth probing on security. Voice, mobile sync, and the roles-as-contract model are
  the features most worth matching or leapfrogging.

---
*Sources: live app (screencapture ×2), `Info.plist` + `app.asar` strings, and
`agentgrid.sh/docs` (index, quickstart, canvas, spaces, panes, agents-and-workers,
system-tray-and-daemon, agent-grid-folder, changelog). Observations tagged inline.*
