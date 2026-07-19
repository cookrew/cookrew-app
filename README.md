# Cookrew

An open-source spatial workspace for AI agents — the desktop half of Cookrew, the multiplayer kitchen for humans & agents.
Terminals, sticky notes, and live browsers live together on an infinite canvas,
wired with cables — and every connected agent gets a `cookrew` CLI to talk to its
neighbors, read/write notes, drive browsers, recruit teammates, and schedule routines.

Built with Electron + React, so it runs on macOS, Linux, and Windows.

## Features

- **Infinite canvas** — dark dotted grid, pan/zoom, minimap, drag/resize nodes
- **Terminal nodes** — real PTYs (node-pty) rendered with xterm.js; agent presets
  (Claude Code, Codex, OpenCode, plain shell); Orch flag for orchestrator terminals
- **Notes** — markdown sticky notes, auto-named from their first line (rename-on-edit),
  persisted as real `.md` files under `~/.cookrew/notes`
- **Connections** — dashed cables between any nodes; connectivity defines what an
  agent can see and touch through the CLI
- **Browsers** — embedded browser nodes with per-browser isolated sessions and a full
  automation surface (snapshot with `@e1` refs, click, fill, type, key, navigate,
  evaluate, scroll, text/html extraction)
- **Voice mode** (Agent Grid-inspired) — agents talk back: `cookrew voice on` speaks every
  completed `ask` through macOS `say`; pick the voice (`cookrew voice list/set`), speed
  (`voice rate`), or speak ad hoc (`voice say "..."`)
- **Mobile companion** (Agent Grid-inspired) — `cookrew mobile` prints a QR; the phone's
  browser gets a native-feeling client (LAN HTTP, no install): terminal tabs, live
  output tail, prompt composer, 🎙️ voice dictation and spoken replies via the
  browser's own Web Speech API
- **`cookrew` CLI** — auto-installed into every terminal's PATH (`COOKREW_SOCKET`,
  `COOKREW_TERMINAL_ID`, `COOKREW_CLI` env vars), speaking newline-delimited JSON over a
  Unix socket to the app:
  - `cookrew list` / `cookrew ask "Agent" "prompt"` / `cookrew ask "Agent" --raw "2\n"` / `cookrew check "Agent"`
  - `cookrew note create|read|write|edit|delete`
  - `cookrew browser create|snapshot|click|fill|type|key|navigate|evaluate|scroll|text|html|info`
  - `cookrew recruit "Name" --preset "Codex"` / `cookrew dismiss` / `cookrew connect` (Orch only)
  - `cookrew routine create "Nightly" --command "..." --every 30m|--daily 02:00` + list/run/enable/disable/delete
  - `cookrew notify "message"` — desktop notification
- **ask engine** — prompts are written into the target PTY; a headless xterm mirrors
  every terminal in the main process, detects output quiescence, and returns the newly
  produced text, blocking until the reply is complete
- **Workspace persistence** — the whole canvas (nodes, connections) is restored on
  launch from `~/.cookrew/workspace.json`

## Run it

```bash
npm install        # rebuilds node-pty against Electron's ABI
npm run dev        # dev app with HMR
npm test           # vitest unit tests
npm run build      # production bundles in out/
```

If `node-pty` fails to rebuild with `'functional' file not found`, your macOS
CommandLineTools are missing their libc++ headers; work around with:

```bash
export CXX="c++ -isystem $(xcrun --show-sdk-path)/usr/include/c++/v1"
npx electron-rebuild -f -w node-pty
```

## Architecture

```
┌────────────────────────── Electron main ──────────────────────────┐
│  WorkspaceStore (source of truth, ~/.cookrew/*.json + notes/*.md)    │
│  PtyManager     (node-pty sessions + headless-xterm mirrors)      │
│  ask engine     (prompt → PTY, quiescence detection, output diff) │
│  RoutineScheduler (cron-lite: --every / --daily)                  │
│  Socket server  (Unix socket, newline-delimited JSON = CLI API)   │
└──────┬──────────────────────────────┬─────────────────────────────┘
       │ IPC (state sync, pty stream) │ browser commands
┌──────▼──────────────────────────────▼─────────────────────────────┐
│  Renderer: React + React Flow canvas                              │
│  TerminalNode (xterm.js) · NoteNode (marked) · BrowserNode         │
│  (webview + snapshot/refs engine) · CableEdge · Toolbar · MiniMap  │
└───────────────────────────────────────────────────────────────────┘
       ▲
       │ Unix socket (COOKREW_SOCKET)
  cookrew CLI (cli/cookrew.mjs, copied next to the socket, on every PTY's PATH)
```

Design choices:

- The CLI is the entire agent API — agents need zero SDKs, just a binary on PATH.
- Connectivity is authorization: `cookrew` only reaches nodes wired to your terminal.
- Orch-gated verbs (recruit, dismiss, connect, routines, notify) keep ordinary
  agents from restructuring the canvas.
- Notes rename themselves from their first line unless the user pins a custom name.

## Roadmap (not yet implemented)

- Stations (git-isolated per-branch working trees via worktrees; one station per branch)
- Roles (`role.json` presets injected as recruit context) and `--replace` swaps
- Menu — command palette, prompt composer, file-tree nodes, groups/tidy
- Remote environments (SSH/Docker bridge over TCP with per-terminal tokens)
- Sous — local-model sous-chef companion

## License

MIT
