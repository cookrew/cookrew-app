# Scout Report: Maestri

> Hands-on evaluation of **Maestri** v0.34.3 (build 129) for a gap analysis vs **AgentGrid** and **Cookrew**.
> Conducted from *inside* Maestri (as the terminal agent "Maestri-Scout") using the live `maestri` CLI, the official docs at themaestri.app, and a teardown of `/Applications/Maestri.app`.
> Date: 2026-07-19.

---

## 1. Overview & Tech Stack

**Maestri** ("the conductor's collective") is a **native macOS spatial workspace for orchestrating AI coding agents**. It is explicitly *not* an agent itself — it's the **canvas + orchestration layer** that runs existing CLI agents (Claude Code, Codex, Gemini, OpenCode, etc.) inside real terminals and lets them see each other, share notes, drive browsers, and be scheduled — all arranged on an infinite 2D canvas.

Tagline from the docs: *"a new kind of productivity app for the agentic AI era."* The mental model is a design tool (Figma-like canvas) crossed with a terminal multiplexer crossed with an agent conductor.

### Tech stack (confirmed by bundle teardown)

| Layer | Implementation | Evidence |
|---|---|---|
| **Language / UI** | **Native Swift + SwiftUI + AppKit** | `libswiftCore`, `SwiftUI.framework`, `AppKit.framework` linked; Swift-mangled symbols (`_TtC7Maestro…`) |
| **Terminal emulator** | **SwiftTerm** (vendored, `SwiftTerm_SwiftTerm.bundle`) | `_TtC9SwiftTerm10*` symbols: `Terminal`, `LocalProcessTerminalView`, `HeadlessTerminal`, `EscapeSequenceParser` |
| **Terminal rendering** | **Metal** GPU renderer + CoreText rasterizer | `MetalTerminalRenderer`, `CoreTextGlyphRasterizer`, `GlyphAtlas`; `Metal.framework`, `MetalKit.framework` |
| **Terminal extras** | Kitty graphics + Sixel + inline images | `KittyGraphicsState`, `SixelDcsHandler`, `ImageCell` |
| **Browser / Portals** | **WebKit (Safari)** — isolated instance per portal | `WebKit.framework`; `PortalWebKitView`, `window.webkit.messageHandlers.*` strings |
| **On-device AI (Ombro)** | **Apple FoundationModels** (weak-linked, on-device) | `FoundationModels.framework … (weak)` |
| **Crypto / auth** | CryptoKit (terminal IDs + tokens) | `CryptoKit.framework` |
| **Search / indexing** | CoreSpotlight | `CoreSpotlight.framework` |
| **Auto-update** | **Sparkle 2.9** (+ Setapp distribution) | `Sparkle.framework`; `setappPublicKey.pem`, `NSUpdateSecurityPolicy → SetappAgent` |
| **File isolation (Floors)** | **APFS copy-on-write clones** | strings referencing APFS / clonefile + git; "…not a git repository on an APFS volume, so the floor shares the ground directory" |

- **Bundle ID:** `com.evercraftlabs.Maestro` (vendor: **Evercraft Labs**; product renamed Maestro → Maestri).
- **Binary:** Mach-O **universal** (x86_64 + arm64), ~30 MB. Category: productivity.
- **Min OS:** macOS 15.4; **Ombro** (on-device AI) requires **Apple Silicon + macOS Tahoe 26**.
- **Distribution:** direct (Sparkle) and **Setapp**.
- **Doc type:** owns `com.evercraftlabs.Maestro.workspace` (`.maestri`-style workspace files).

### The `maestri` CLI (the agent's hands)

The killer integration detail: **every terminal Maestri spawns gets a `maestri` binary injected onto its `PATH`**, wired to that terminal over a **per-terminal Unix domain socket**. This is how an agent *acts on the canvas* from inside its own shell.

- Binary lives at `Maestri.app/Contents/Resources/maestri` (~200 KB), deployed per-session into a temp dir on `PATH` (fallback `$MAESTRI_CLI` if the shell resets PATH).
- `maestri debug` confirms: `Terminal ID`, a `maestri.sock` unix socket, live connection test.
- **No MCP server, no external dependency** — the CLI *is* the agent-tool surface. (Maestri also auto-loads a "Maestri Agent Skill" into connected agents so they know the verbs.)

**Verified hands-on:** `maestri help`, `maestri list`, `maestri debug`, and full `note create → read → delete` round-trip all worked live from this terminal.

---

## 2. Full Capability List

### Canvas & nodes
- **Infinite 2D canvas**; pan/zoom (trackpad, mouse, keyboard), Space-drag pan, design-tool conventions.
- **5 node types:** Terminal, Note, Text, Drawing (sketch), File Tree.
- **Node Groups** (labeled frames, move together), **align/distribute**, **Tidy** (auto-grid), **magnetic tile snapping** (edge-align + gap-fill).
- Keyboard nav *between* connected nodes (arrow keys); **⇧A** jumps to the next agent needing attention; **⌘+number** focuses a terminal.

### Terminals & agents
- Each terminal is a **full interactive shell** (SwiftTerm) running a chosen **agent preset** (Claude Code, Codex, Gemini, OpenCode…; must be pre-installed).
- **Roles** (Lead / Coder / Reviewer / Tester + custom): instruction sets that start the agent in a subdir with its own instruction file; portable **`role.json`** sidecar travels across machines/workspaces.
- **Attention dots** (red) when an agent needs input; 30+ **terminal themes** (Dracula, Catppuccin, Tokyo Night…) + custom via `~/.maestri/terminal/themes/`.
- **Dictation** input (mic); **`--raw`** keystroke injection for TUIs (vim/less/htop, interactive menus, arrow/ESC sequences).
- Per-terminal **memory limit** (auto-kill runaway agents); workspace **Unload/hibernate**.

### Prompt Composer
- Rich-text composer floating over any terminal (**⇧P / ⌘⇧P**); **per-terminal drafts** that persist across floor/workspace switches.
- **`@` mentions:** terminals (address agents by name), notes (live), portals, **@Maestro**, and **actions** (@New Note, @New Portal).
- **File/image handling:** paste screenshots / drag files / paperclip → images sent as **native pixels** to compatible CLIs (Claude Code, Codex, Gemini), other files as path chips; images stream to remote hosts over SSH.
- **`/`** jumps to CLI commands (empty composer only).

### Connections (agent wiring)
- **Physics-animated cables** — **Rope** (default, swaying physics) or **Circuit** (axis-aligned traces).
- **Terminal↔Terminal:** real **agent-to-agent messaging**, any-CLI-to-any-CLI ("Claude can talk to Codex"). Implemented by auto-deploying the **Maestri Agent Skill**.
- **Agent↔Note:** persistent notebook the agent reads/edits via CLI, survives restarts.
- **Agent↔Portal:** grants browser automation.
- **Note chaining:** connect only the entry note → agent gets the whole chain (mind-map context).

### Notes
- Sticky notes that are **real `.md` files on disk**; full markdown engine, **Raw** + **Formatted** live-preview modes; inline images (visible to agents too).
- Auto-name from first line; **Move to…** relocate backing file; drag files from Finder onto canvas; **⌘W** deletes node *and* file.
- CLI: `note create / read / write / edit / delete` (edit does substring replace).

### File Tree
- Embedded browser, multiple independent instances; **4 views: List, Icon Grid (Quick Look), Diff (uncommitted changes), Graph (git commit history/branches)**.
- **Git ops in-app:** branch indicator, commit, pull/push, checkout, branch create, merge, fetch, stash.
- **Built-in code editor:** syntax highlight, find/replace, multi-cursor, auto-close brackets, smart indent; select text → chat icon to send to agent.
- **⌘P** = Batuta scoped to tree (fuzzy filenames); `>` prefix = content search + jump to line.
- Drag files → agent terminal (context) or → canvas (preview node).

### Batuta Search (command palette)
- Keyboard-first ("conductor's baton"): **P** to open; fuzzy, case- & accent-insensitive.
- Indexes **across all workspaces & floors**: terminals, notes (incl. **full body**), text blocks, files, links, file trees, portals, workspaces.
- Navigate (auto-switches workspace/floor), **Ask…** / **Check…** agents in-palette, global + contextual **actions**.
- Deterministic ranking (no semantic/ML) — current workspace weighted, name > body matches.

### Portals (embedded browser)
- **Isolated WebKit instance per portal**, own storage; connect portals to share auth/cookies; Chrome support "planned."
- Agent automation via CLI (**no MCP needed**): navigate/click/type/scroll/hover/drag, screenshot, `evaluate` JS, read HTML/DOM, console, wait-for-element, **resize viewport**, **spoof user-agent** (ios/android/chrome/edge/firefox/desktop). Verified in `maestri portal *` command set.

### Maestro Mode (orchestration)
- Promotes one terminal to **manager**: `recruit` teammates (with `--preset / --role / --floor / --command / --dir`), `recruit --replace` (hot-swap agent in place, keeps connections/routines), `dismiss`, `connect`, `notify` (macOS notification to the user).
- Gates the privileged CLI surface: **workspace/floor create, role & routine management, preset/role/floor lists are Maestro-only** (confirmed: non-Maestro terminal is refused these).
- Recruits self-identify via `maestri list` (name, role, connections). Connected notes = team "source of truth."

### Floors (branch/APFS isolation) — see §3
- `floor create [--branch B] [--existing-branch] [--no-git] [--copy-ground]`, `floor list`.

### Routines (scheduling)
- Scheduled prompts/commands per terminal: `--every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once "…"`; `--count`, `--until`, `--reminder`, `--no-notify`, `--pre-run` (output injected at `{{output}}`), enable/disable/run/edit/delete.
- Chain steps with `&&`; use cases: periodic tests, health checks, scheduled reviews, portal automations, data extraction → notes.

### Environments — see §3
- **Local, SSH, Docker (attach), Docker Sandbox, Custom Runtime** (Podman / Apple containers / Lima).

### Ombro (on-device AI companion) — see §3

### Workspaces
- Project unit: remembers layout, terminal positions, agent assignments, settings; run in background, multiple active at once, **Unload** to hibernate.
- Sidebar org: **Folders** (same project, different dirs), **Groups** (labeled dividers), pinned, mini sidebar.
- `CLAUDE.md` + `AGENTS.md` standing instructions, auto-synced for mixed agent fleets.
- CLI: `workspace create --dir [--from clone] [--group] [--folder]`, `workspace move`, `workspace list`.

---

## 3. Standout / Unique Features

### 🏢 Floors = APFS copy-on-write + git branch isolation
The strongest structural idea. A **floor** is a **full clone of the repo that shares storage via APFS copy-on-write** — instant to create, only modified files consume disk. Each floor is an independent git worktree/checkout with its **own branch, mirrored back into the origin repo** so GitHub/IDE see it. Stored under **`.maestri/floors`**, auto-cleaned when the last floor is deleted. `--copy-ground` clones the canvas layout (notes/terminals/text) into the new floor. Graceful fallback: if the dir isn't a git repo on an APFS volume, the floor shares the ground directory. → *True parallel-agent isolation with near-zero cost; directly comparable to git-worktree tooling but transparent and canvas-native.*

### 🎼 Batuta — unified keyboard command surface
One palette to search/navigate/act **across every workspace and floor**, searching **note/text full bodies**, with in-palette **Ask/Check** agent flows. Deterministic (no embeddings) — a deliberate "fast & predictable" choice, not semantic.

### 🌓 Ombro — on-device AI supervisor
A floating **AI companion built on Apple FoundationModels, 100% on-device** ("no API calls, no cloud, no latency"; code/terminal output never leaves the Mac). It **passively watches agents**, notifies on completion/stop with **summaries + terminal snapshots + suggested next actions**, answers "what is Codex doing?", and creates/summarizes **"Ombro Notes"** across a workspace. Requires Apple Silicon + macOS Tahoe 26. → *A privacy-preserving meta-agent layer competitors relying on cloud LLMs can't cheaply match.*

### 🔌 Connection "physics" as a first-class UX + wiring model
Cables aren't decoration — **wiring two terminals literally installs the agent-to-agent skill** and defines who can message whom / who reads which note / who drives which portal. Rope-vs-Circuit is aesthetic; the graph is functional. Subtlety: **the receiving terminal must stay *unselected*** — Maestri only monitors unfocused terminals to deliver replies.

### 🌐 Environments: SSH / Docker / Sandbox / Custom, with a Bridge Port
Terminals run **Local (unix socket), SSH (reverse tunnel from server Bridge Port → Mac, key-based, no server daemon), Docker attach (never creates/mutates the container), Docker Sandbox (network-policy-scoped localhost access), or Custom Runtime (Podman/Apple containers/Lima)**. Remote agents get injected `terminal ID + bridge endpoint + auth token` for **full feature parity** (skills, CLI, uploads, agent comms) regardless of location. → *Agents orchestrate uniformly across local, remote, and sandboxed contexts — a serious differentiator.*

### ✍️ Prompt Composer — native pixels & cross-agent addressing
Floating rich composer with **per-terminal persistent drafts**, `@`-mentions of terminals/notes/portals/@Maestro/actions, and **images sent as native pixels** to Claude/Codex/Gemini (streamed to remote hosts on SSH). Small but high-leverage ergonomics.

### 🌲 File Tree with git graph + diff + native editor
Not just a browser: **Diff view**, **git Graph view (commit history/branches)**, full in-app git ops, and a **built-in multi-cursor code editor** with select-to-chat. Content search via `>`. Effectively a mini-IDE panel on the canvas.

---

## 4. Data Model & Storage

- **Workspace** = project unit; persists canvas layout, node positions, terminal↔agent assignments, roles, connections, settings. Backed by a `com.evercraftlabs.Maestro.workspace` document. Multiple can be live; **Unload** hibernates one.
- **Notes** are **plain `.md` files on disk** (default in Maestri's storage folder, relocatable via *Move to…*). This is the key portability decision — notes are not locked in a proprietary DB; they're git-friendly markdown. Deleting the node deletes the file.
- **Roles** carry a portable **`role.json`** sidecar (travels across workspaces/machines); role instruction files live in project subdirs.
- **Floors** live under **`.maestri/floors/`** as APFS CoW clones; branches mirror into the origin git repo; auto-GC'd.
- **Standing instructions:** `CLAUDE.md` / `AGENTS.md` at workspace root, auto-synced across mixed agents.
- **Terminal themes:** `~/.maestri/terminal/themes/`.
- **Portals:** each an isolated WebKit store; connected portals share session storage.
- **Runtime IPC:** per-terminal **Unix domain socket** (`…/maestri-<id>/maestri.sock`); terminal identity + auth via **CryptoKit-derived IDs/tokens**; remote environments bridged over a **Bridge Port** (SSH reverse tunnel / Docker network policy).
- **Indexing:** Batuta indexes across all workspaces/floors (names + full note/text bodies); CoreSpotlight linked.
- **No cloud backend evident** — storage is local files + local sockets; the only network egress is Sparkle/Setapp updates and whatever the *agents themselves* call. Ombro is on-device.

---

## 5. UX & Notable Design Choices

- **Spatial-first, keyboard-fast.** Figma-style infinite canvas, but every core action has a shortcut (P Batuta, ⇧P composer, L connect, ⇧A next-attention, ⌘+num focus, ⇧O Ombro). The canvas is the memory; you "pick up where you left off instantly."
- **Agents as citizens, app as conductor.** Maestri ships zero model of its own for the work — it wraps *your* installed CLIs and makes them interoperable (any-to-any messaging). Vendor-neutral by design.
- **The CLI is the API.** Instead of an MCP server, Maestri injects a `maestri` binary + Unix socket into each shell and auto-loads an agent skill. Agents act on the canvas with plain shell commands (`maestri ask`, `note`, `portal`, `recruit`…). Extremely low-friction; **no MCP config, no external deps** (repeatedly emphasized in docs).
- **Privilege tiers.** "Maestro Mode" gates destructive/structural verbs (recruit/dismiss, workspace/floor create, role & routine mgmt) behind an explicit toggle — verified live (a non-Maestro terminal is refused `role/floor/workspace/preset list`). Prevents rogue agents from spawning stray environments.
- **Honest constraints surfaced in-product.** Memory reality stated plainly (agents eat 500–700 MB; app ~200 MB) with a per-terminal memory cap + Unload as mitigations. `maestri debug` gives first-class connection diagnostics. Diagnostic export strips code/workspace data.
- **Physics + polish as signal, not gimmick.** Rope/circuit cables, magnetic snapping, Tidy, tilted image previews — a lot of craft; but the physics graph doubles as the permission/routing model.
- **Deliberate simplicity in search.** Batuta is fuzzy+weighted, **not** semantic — a bet on determinism/speed over "smart." Worth noting as a philosophical contrast if Cookrew/AgentGrid lean on embeddings.
- **Distribution & platform bets.** Native Swift, Metal-rendered SwiftTerm, WebKit portals, Apple FoundationModels — an **all-in Apple-platform, on-device-AI** posture (macOS 15.4+, Ombro needs Tahoe 26 + Apple Silicon). High performance & privacy ceiling; zero cross-platform story (macOS only).

---

### Quick gap-analysis hooks (for the AgentGrid / Cookrew comparison)

| Axis | Maestri's position |
|---|---|
| **Isolation** | APFS-CoW floors + git-branch mirroring (instant, cheap, IDE-visible) |
| **Multi-agent comms** | Any-CLI ↔ any-CLI via injected skill over unix socket; wiring = permission graph |
| **Remote/sandbox** | Local / SSH-tunnel / Docker-attach / Docker-Sandbox / custom runtime, full parity |
| **Agent tool surface** | `maestri` CLI (no MCP), auto-loaded skill |
| **Supervisor AI** | Ombro — on-device Apple FoundationModels, private, macOS-only |
| **Browser** | WebKit portals, per-portal isolation, CLI-driven automation |
| **Storage** | Local files (notes = plain `.md`), no cloud backend |
| **Platform** | macOS-native only; Apple-Silicon-gated for on-device AI |
| **Persistence/UX** | Spatial canvas as durable memory; keyboard-first command palette (Batuta) |
| **Scheduling** | Built-in cron-like routines with pre-run injection & chaining |

*Sources: live `maestri` CLI (help/list/debug/note round-trip), themaestri.app/en/docs/* (intro, workspaces, canvas, batuta-search, terminals, prompt-composer, notes, connections, maestro, file-tree, floors, portals, routines, environments, ombro, troubleshooting), and teardown of `/Applications/Maestri.app` (Info.plist, otool -L, symbol/strings analysis).*
