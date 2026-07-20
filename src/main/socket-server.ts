import net from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  AgentRole,
  CanvasNode,
  CliRequest,
  CliResponse,
  DEFAULT_NOTE_SIZE,
  DEFAULT_TERMINAL_SIZE,
  GitInfo,
  NoteNodeData,
  TeamForkSpec,
  TeamMeta,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta
} from '../shared/model'
import { WorkspaceStore } from './store'
import { PtyManager } from './pty'
import { askRaw, askTerminal, decodeRawEscapes } from './ask'
import { PRESETS } from './presets'
import { RoutineScheduler, parseInterval } from './routines'
import type { VoiceEngine } from './voice'
import type { TurnTracker } from './turn-tracker'

export interface SocketServerDeps {
  store: WorkspaceStore
  ptys: PtyManager
  /** Spawn a terminal's PTY with turn tracking (same path as IPC creation). */
  spawnTerminal: (t: { id: string; command: string; cwd: string }) => void
  /** Turn history source for `cookrew fork` validation/output. */
  turns: TurnTracker
  /** Fork an agent from one of its turns (same path as IPC forking). */
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData
  routines: RoutineScheduler
  /** Ask the renderer to run a browser command; resolves with its output. */
  browserCommand: (args: string[], terminalId: string) => Promise<string>
  notify: (message: string) => void
  /** Debug helper: capture the app window to a PNG, returns the file path. */
  captureWindow: () => Promise<string>
  /** Debug helper: inject real input events into the app window. */
  injectInput: (args: string[]) => Promise<string>
  voice: VoiceEngine
  /** LAN URLs of the mobile companion server. */
  mobileUrls: () => string[]
  /** Workspace registry + switching (switching rebuilds PTYs). */
  listWorkspaces: () => WorkspaceList
  createWorkspace: (name: string, dir: string) => WorkspaceMeta
  switchWorkspace: (nameOrId: string) => WorkspaceMeta
  /** Workspace v2: remove + multi-directory + per-terminal cwd + git. */
  removeWorkspace: (nameOrId: string) => WorkspaceList
  addWorkspaceDir: (id: string, dir: string) => WorkspaceList
  removeWorkspaceDir: (id: string, dir: string) => WorkspaceList
  setPrimaryDir: (id: string, dir: string) => WorkspaceList
  setTerminalCwd: (nodeId: string, dir: string) => CanvasNode
  gitInfo: (dir: string) => Promise<GitInfo>
  /** Team fork/save + roles (spec note team-fork-roles-v1). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>
  teamSave: (name?: string) => TeamMeta
  teamList: () => TeamMeta[]
  roleSave: (input: { nodeId: string; name: string; rolePrompt: string }) => AgentRole
  roleList: () => AgentRole[]
  roleDelete: (name: string) => boolean
}

/**
 * Newline-delimited JSON server on a Unix socket. This is the `cookrew` CLI's
 * backend over the local bridge socket.
 */
export function startSocketServer(deps: SocketServerDeps): net.Server {
  const { ptys } = deps
  if (existsSync(ptys.socketPath)) unlinkSync(ptys.socketPath)

  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void handleLine(line, socket, deps)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
  })

  server.listen(ptys.socketPath)
  return server
}

async function handleLine(
  line: string,
  socket: net.Socket,
  deps: SocketServerDeps
): Promise<void> {
  let request: CliRequest
  try {
    request = JSON.parse(line) as CliRequest
  } catch {
    socket.write(JSON.stringify({ id: 'unknown', ok: false, error: 'Bad request JSON' }) + '\n')
    return
  }
  try {
    const output = await dispatch(request, deps)
    respond(socket, { id: request.id, ok: true, output })
  } catch (error) {
    respond(socket, {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function respond(socket: net.Socket, response: CliResponse): void {
  try {
    socket.write(JSON.stringify(response) + '\n')
  } catch (error) {
    console.error('Socket write failed:', error)
  }
}

// ---- command dispatch ----

async function dispatch(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const { cmd, args } = request
  switch (cmd) {
    case 'list':
      return cmdList(request, deps)
    case 'ask':
      return cmdAsk(request, deps)
    case 'check':
      return cmdCheck(request, deps)
    case 'note':
      return cmdNote(request, deps)
    case 'connect':
      return cmdConnect(request, deps)
    case 'recruit':
      return cmdRecruit(request, deps)
    case 'dismiss':
      return cmdDismiss(request, deps)
    case 'fork':
      return cmdFork(request, deps)
    case 'preset':
      return cmdPreset()
    case 'notify':
      requireOrch(request, deps)
      deps.notify(args.join(' '))
      return 'OK'
    case 'browser':
      return deps.browserCommand(args, request.terminalId)
    case 'routine':
      return cmdRoutine(request, deps)
    case 'voice':
      return cmdVoice(request, deps)
    case 'mobile':
      return cmdMobile(deps)
    case 'workspace':
      return cmdWorkspace(request, deps)
    case 'team':
      return cmdTeam(request, deps)
    case 'role':
      return cmdRole(request, deps)
    case 'terminal':
      return cmdTerminalCwd(request, deps)
    case 'git':
      return cmdGit(request, deps)
    case 'app-shot':
      return deps.captureWindow()
    case 'ui':
      return deps.injectInput(args)
    case 'help':
      return HELP_TEXT
    default:
      throw new Error(`Unknown command '${cmd}'. Run 'cookrew help'.`)
  }
}

function self(request: CliRequest, deps: SocketServerDeps): TerminalNodeData {
  const node = deps.store.node(request.terminalId)
  if (!node || node.kind !== 'terminal') {
    throw new Error('This shell is not attached to a Cookrew terminal node')
  }
  return node
}

function requireOrch(request: CliRequest, deps: SocketServerDeps): TerminalNodeData {
  const me = self(request, deps)
  if (!me.orch) throw new Error('This terminal is not the Orch')
  return me
}

function findConnected(
  request: CliRequest,
  deps: SocketServerDeps,
  name: string,
  kind: 'terminal' | 'note' | 'browser'
) {
  const me = self(request, deps)
  const target = deps.store
    .connectedTo(me.id)
    .find((n) => n.kind === kind && n.name.toLowerCase() === name.toLowerCase())
  if (!target) throw new Error(`${kind === 'terminal' ? 'Agent' : kind} '${name}' not found among your connections. Run 'cookrew list'.`)
  return target
}

function cmdList(request: CliRequest, deps: SocketServerDeps): string {
  const me = self(request, deps)
  const connected = deps.store.connectedTo(me.id)
  const agents = connected.filter((n) => n.kind === 'terminal') as TerminalNodeData[]
  const notes = connected.filter((n) => n.kind === 'note') as NoteNodeData[]
  const browsers = connected.filter((n) => n.kind === 'browser')

  const lines: string[] = ['You:', `  - name: "${me.name}", orch: ${me.orch}`]
  if (agents.length > 0) {
    lines.push('', 'Connected agents (use `cookrew ask/check`):')
    for (const a of agents) {
      lines.push(`  - name: "${a.name}"${a.role ? `, role: "${a.role}"` : ''}`)
    }
  }
  if (browsers.length > 0) {
    lines.push('', 'Connected browsers (use `cookrew browser ...`):')
    for (const p of browsers) lines.push(`  - name: "${p.name}" - url: ${(p as { url: string }).url}`)
  }
  if (notes.length > 0) {
    lines.push('', 'Connected notes (use `cookrew note read/write/edit`):')
    for (const n of notes) lines.push(`  - name: "${n.name}"${n.locked ? ' (locked)' : ''}`)
  }
  if (agents.length + notes.length + browsers.length === 0) {
    lines.push('', 'No connected agents, notes, or browsers. Connect nodes on the canvas or use `cookrew note create`.')
  }
  return lines.join('\n')
}

async function cmdAsk(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [name, prompt] = request.args
  if (!name) throw new Error('Usage: cookrew ask "Agent Name" "prompt" | cookrew ask "Agent" --raw "bytes"')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  const session = deps.ptys.get(target.id)
  if (!session) throw new Error(`Agent '${target.name}' has no running terminal`)
  if (request.flags.raw) {
    return askRaw(session, decodeRawEscapes(String(request.flags.raw)))
  }
  if (!prompt) throw new Error('Missing prompt')
  const reply = await askTerminal(session, prompt)
  if (deps.voice.enabled) {
    deps.voice.speakReply(target.name, reply).catch((error) => {
      console.error('Voice reply failed:', error)
    })
  }
  return reply
}

function cmdCheck(request: CliRequest, deps: SocketServerDeps): string {
  const [name] = request.args
  if (!name) throw new Error('Usage: cookrew check "Agent Name"')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  const session = deps.ptys.get(target.id)
  if (!session) throw new Error(`Agent '${target.name}' has no running terminal`)
  return session.viewportText()
}

function cmdNote(request: CliRequest, deps: SocketServerDeps): string {
  const [sub, ...rest] = request.args
  const me = self(request, deps)
  switch (sub) {
    case 'create': {
      const content = rest[0] ?? ''
      const note = deps.store.createNote({
        customName: null,
        content,
        locked: false,
        position: { x: me.position.x - DEFAULT_NOTE_SIZE.width - 60, y: me.position.y },
        size: DEFAULT_NOTE_SIZE
      })
      deps.store.connect(me.id, note.id)
      return `Created note "${note.name}"`
    }
    case 'read': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      const lines = note.content.split('\n')
      const offset = rest[1] ? Math.max(1, parseInt(rest[1], 10)) : 1
      const limit = rest[2] ? parseInt(rest[2], 10) : lines.length
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`)
      return [`[${lines.length} lines total]`, ...numbered].join('\n')
    }
    case 'write': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      if (note.locked) throw new Error(`Note '${note.name}' is locked`)
      deps.store.writeNote(note.id, rest[1] ?? '')
      return 'OK'
    }
    case 'edit': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      if (note.locked) throw new Error(`Note '${note.name}' is locked`)
      const [, oldText, newText] = rest
      if (oldText === undefined || newText === undefined) {
        throw new Error('Usage: cookrew note edit "Name" "old text" "new text"')
      }
      if (!note.content.includes(oldText)) {
        throw new Error(`Text not found in note '${note.name}'`)
      }
      deps.store.writeNote(note.id, note.content.replace(oldText, newText))
      return 'OK'
    }
    case 'delete': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      deps.store.removeNode(note.id)
      return `Deleted note "${note.name}"`
    }
    default:
      throw new Error('Usage: cookrew note create|read|write|edit|delete ...')
  }
}

function cmdConnect(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [fromName, toName] = request.args
  if (!fromName || !toName) throw new Error('Usage: cookrew connect "From" "To"')
  const me = self(request, deps)
  const reach = [deps.store.node(me.id)!, ...deps.store.connectedTo(me.id)]
  const resolve = (name: string) => {
    const found = reach.find((n) => n.name.toLowerCase() === name.toLowerCase())
      ?? deps.store.nodeByName(name)
    if (!found) throw new Error(`'${name}' not found`)
    return found
  }
  const a = resolve(fromName)
  const b = resolve(toName)
  deps.store.connect(a.id, b.id)
  return `Connected "${a.name}" and "${b.name}"`
}

function cmdRecruit(request: CliRequest, deps: SocketServerDeps): string {
  const me = requireOrch(request, deps)
  const [name] = request.args
  const presetName = String(request.flags.preset ?? 'Claude Code')
  const preset = PRESETS.find((p) => p.name.toLowerCase() === presetName.toLowerCase())
  if (!preset) {
    throw new Error(`Unknown preset '${presetName}'. Run 'cookrew preset list'.`)
  }
  const command = request.flags.command ? String(request.flags.command) : preset.command
  const cwd = request.flags.dir ? String(request.flags.dir) : me.cwd
  const siblings = deps.store.connectedTo(me.id).filter((n) => n.kind === 'terminal').length
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: name || preset.name,
    preset: preset.name,
    command,
    cwd,
    orch: false,
    role: request.flags.role ? String(request.flags.role) : null,
    position: {
      x: me.position.x + (siblings + 1) * (DEFAULT_TERMINAL_SIZE.width + 60),
      y: me.position.y + 120
    },
    size: DEFAULT_TERMINAL_SIZE
  }
  const added = deps.store.addNode(terminal) as TerminalNodeData
  deps.store.connect(me.id, added.id)
  deps.spawnTerminal(added)
  return `Recruited "${added.name}" (${preset.name})`
}

function cmdFork(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [name] = request.args
  if (!name) throw new Error('Usage: cookrew fork "Agent" [--turn N]')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  const turnIndex = request.flags.turn ? parseInt(String(request.flags.turn), 10) : undefined
  if (request.flags.turn !== undefined && Number.isNaN(turnIndex)) {
    throw new Error('--turn must be a turn number (see the card pager or omit for the latest turn)')
  }
  const fork = deps.forkTerminal(target.id, turnIndex)
  const me = self(request, deps)
  deps.store.connect(me.id, fork.id)
  return `Forked "${target.name}" at turn ${fork.forkOf?.turnIndex} → "${fork.name}" (context is being replayed to it now)`
}

function cmdDismiss(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const target = findConnected(request, deps, request.args[0], 'terminal')
  deps.ptys.kill(target.id)
  deps.store.removeNode(target.id)
  return `Dismissed "${target.name}"`
}

async function cmdVoice(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [sub, ...rest] = request.args
  switch (sub) {
    case 'on':
      deps.voice.setEnabled(true)
      return 'Voice replies on — agents will speak when an ask completes.'
    case 'off':
      deps.voice.setEnabled(false)
      return 'Voice replies off'
    case 'status':
    case undefined:
      return deps.voice.status()
    case 'list':
      return deps.voice.listVoices()
    case 'set':
      if (!rest[0]) throw new Error('Usage: cookrew voice set "Voice Name" (see `cookrew voice list`)')
      deps.voice.setVoice(rest[0])
      return `Voice set to "${rest[0]}"`
    case 'rate': {
      const rate = parseInt(rest[0] ?? '', 10)
      if (Number.isNaN(rate)) throw new Error('Usage: cookrew voice rate 200')
      deps.voice.setRate(rate)
      return `Voice rate set to ${rate} wpm`
    }
    case 'say':
      if (!rest[0]) throw new Error('Usage: cookrew voice say "text"')
      await deps.voice.speak(rest.join(' '))
      return 'OK'
    default:
      throw new Error('Usage: cookrew voice on|off|status|list|set|rate|say')
  }
}

function cmdWorkspace(request: CliRequest, deps: SocketServerDeps): string {
  const [sub, name] = request.args
  if (sub === 'list' || sub === undefined) {
    const { workspaces, activeId } = deps.listWorkspaces()
    return workspaces
      .map((w) => {
        const extra = w.dirs.length > 1 ? ` (+${w.dirs.length - 1} more)` : ''
        return `${w.id === activeId ? '* ' : '  '}${w.icon} ${w.name}  —  ${w.dir}${extra}`
      })
      .join('\n')
  }
  if (sub === 'dir') return cmdWorkspaceDir(request, deps)
  // create/switch/remove restructure the canvas, so gate them behind Orch.
  requireOrch(request, deps)
  switch (sub) {
    case 'create': {
      if (!name) throw new Error('Usage: cookrew workspace create "Name" --dir PATH')
      const dir = request.flags.dir ? String(request.flags.dir) : ''
      const meta = deps.createWorkspace(name, dir)
      return `Created and switched to workspace "${meta.name}" (${meta.dir})`
    }
    case 'switch': {
      if (!name) throw new Error('Usage: cookrew workspace switch "Name"')
      const meta = deps.switchWorkspace(name)
      return `Switched to workspace "${meta.name}"`
    }
    case 'remove': {
      if (!name) throw new Error('Usage: cookrew workspace remove "Name"')
      deps.removeWorkspace(name)
      return `Removed workspace "${name}"`
    }
    default:
      throw new Error('Usage: cookrew workspace list|create|switch|remove|dir ...')
  }
}

/** Directory subcommands operate on the ACTIVE workspace. */
function cmdWorkspaceDir(request: CliRequest, deps: SocketServerDeps): string {
  const [, action, dirPath] = request.args
  const { activeId } = deps.listWorkspaces()
  if (action === 'list' || action === undefined) {
    const ws = deps.listWorkspaces().workspaces.find((w) => w.id === activeId)
    return (ws?.dirs ?? [])
      .map((d, i) => `${i === 0 ? '* ' : '  '}${d}`)
      .join('\n')
  }
  requireOrch(request, deps)
  switch (action) {
    case 'add':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir add PATH')
      deps.addWorkspaceDir(activeId, dirPath)
      return `Added directory ${dirPath}`
    case 'remove':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir remove PATH')
      deps.removeWorkspaceDir(activeId, dirPath)
      return `Removed directory ${dirPath}`
    case 'primary':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir primary PATH')
      deps.setPrimaryDir(activeId, dirPath)
      return `Primary directory is now ${dirPath}`
    default:
      throw new Error('Usage: cookrew workspace dir list|add|remove|primary ...')
  }
}

function cmdTerminalCwd(request: CliRequest, deps: SocketServerDeps): string {
  const dir = request.args[1]
  if (!dir) throw new Error('Usage: cookrew terminal cwd PATH')
  const me = self(request, deps)
  deps.setTerminalCwd(me.id, dir)
  return `Terminal cwd set to ${dir} (respawned)`
}

async function cmdGit(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const me = self(request, deps)
  const info = await deps.gitInfo(me.cwd)
  if (!info.isRepo) return `${me.cwd} is not a git repository`
  const state = [
    info.dirty ? 'dirty' : 'clean',
    info.ahead ? `↑${info.ahead}` : '',
    info.behind ? `↓${info.behind}` : ''
  ]
    .filter(Boolean)
    .join(' ')
  return `${info.branch ?? 'detached'} — ${state}  (${info.root})`
}

function cmdMobile(deps: SocketServerDeps): string {
  const urls = deps.mobileUrls()
  const secure = urls.some((u) => u.startsWith('https'))
  return [
    'Cookrew Mobile — open on your phone (same Wi-Fi):',
    ...urls.map((u) => `  ${u}`),
    '',
    secure
      ? 'These are HTTPS (self-signed): the phone will warn once — tap Advanced →\nProceed / Visit anyway. HTTPS is required so 🎙️ voice dictation can use the mic.'
      : '⚠ HTTP only (openssl not found): 🎙️ voice dictation needs HTTPS, so the mic\nwill be blocked on the phone. Everything else works.',
    '',
    'The client lists terminals, tails output, sends prompts, does 🎙️ dictation',
    'and reads replies aloud (Web Speech API).'
  ].join('\n')
}

function cmdRoutine(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [sub, name] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.routines.list()
      if (all.length === 0) return "No routines yet. Create one with 'cookrew routine create \"Name\" --command \"...\" --every 30m'."
      return all
        .map((r) => {
          const schedule = r.schedule.type === 'every' ? `every ${Math.round(r.schedule.ms / 60000)}m` : `daily ${r.schedule.time}`
          return `  - "${r.name}" — ${schedule}, ${r.enabled ? 'enabled' : 'paused'}, fired ${r.fireCount}x`
        })
        .join('\n')
    }
    case 'create': {
      if (!name || !request.flags.command) {
        throw new Error('Usage: cookrew routine create "Name" --command "..." --every 30m | --daily 09:00')
      }
      const schedule = request.flags.every
        ? ({ type: 'every', ms: parseInterval(String(request.flags.every)) } as const)
        : request.flags.daily
          ? ({ type: 'daily', time: String(request.flags.daily) } as const)
          : null
      if (!schedule) throw new Error('Pick a schedule: --every 30m or --daily 09:00')
      let terminalId: string | null = null
      if (request.flags.terminal) {
        const target = findConnected(request, deps, String(request.flags.terminal), 'terminal')
        terminalId = target.id
      } else {
        terminalId = self(request, deps).id
      }
      const created = deps.routines.create({
        name,
        command: String(request.flags.command),
        schedule,
        terminalId,
        enabled: !request.flags.disabled
      })
      return `Created routine "${created.name}"`
    }
    case 'delete':
      return `Deleted routine "${deps.routines.remove(name).name}"`
    case 'enable':
      return `Enabled routine "${deps.routines.setEnabled(name, true).name}"`
    case 'disable':
      return `Paused routine "${deps.routines.setEnabled(name, false).name}"`
    case 'run':
      return `Fired routine "${deps.routines.run(name).name}"`
    default:
      throw new Error('Usage: cookrew routine list|create|delete|enable|disable|run ...')
  }
}

async function cmdTeam(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [sub, name] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.teamList()
      if (all.length === 0) return "No saved teams yet. Save one with 'cookrew team save [\"Name\"]'."
      return all
        .map(
          (t) =>
            `  - "${t.name}" — ${t.terminalCount} agents / ${t.nodeCount} nodes, saved ${new Date(t.savedAt).toLocaleString()}`
        )
        .join('\n')
    }
    case 'save': {
      requireOrch(request, deps)
      const meta = deps.teamSave(name)
      return `Saved team "${meta.name}" (${meta.terminalCount} agents, ${meta.nodeCount} nodes)`
    }
    case 'fork': {
      // CLI forks the whole live canvas at latest turns; fine-grained
      // selection (per-turn, assembled, roles) lives in the picker UI.
      requireOrch(request, deps)
      const spec: TeamForkSpec = {
        name: request.flags.name ? String(request.flags.name) : undefined,
        nodeIds: deps.store.state.nodes.map((n) => n.id),
        choices: [],
        fromSavedTeam: request.flags.from ? String(request.flags.from) : undefined
      }
      const meta = await deps.teamFork(spec)
      return `Forked team into workspace "${meta.name}" and switched to it`
    }
    default:
      throw new Error('Usage: cookrew team save ["Name"] | team list | team fork [--name N] [--from "Saved Team"]')
  }
}

function cmdRole(request: CliRequest, deps: SocketServerDeps): string {
  const [sub, agentName, roleName] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.roleList()
      if (all.length === 0) return "No saved roles yet. Save one with 'cookrew role save \"Agent\" \"RoleName\" --prompt \"...\"'."
      return all
        .map((r) => `  - "${r.name}" (${r.preset}) — ${r.rolePrompt.slice(0, 80)}`)
        .join('\n')
    }
    case 'save': {
      if (!agentName || !roleName) {
        throw new Error('Usage: cookrew role save "Agent" "RoleName" --prompt "role instructions"')
      }
      const node = deps.store.nodeByName(agentName, 'terminal')
      if (!node) throw new Error(`No terminal named '${agentName}' on the canvas`)
      const prompt = request.flags.prompt
        ? String(request.flags.prompt)
        : ((node as TerminalNodeData).role ?? '')
      if (!prompt.trim()) {
        throw new Error(`Pass --prompt "..." (agent '${agentName}' has no stored role text)`)
      }
      const role = deps.roleSave({ nodeId: node.id, name: roleName, rolePrompt: prompt })
      return `Saved role "${role.name}" (${role.preset})`
    }
    case 'delete': {
      requireOrch(request, deps)
      if (!agentName) throw new Error('Usage: cookrew role delete "RoleName"')
      return deps.roleDelete(agentName)
        ? `Deleted role "${agentName}"`
        : `No saved role '${agentName}'`
    }
    default:
      throw new Error('Usage: cookrew role save "Agent" "RoleName" --prompt "..." | role list | role delete "RoleName"')
  }
}

function cmdPreset(): string {
  return [
    'Available agent presets (use as `--preset "Name"` for `cookrew recruit`):',
    ...PRESETS.map((p) => `  - "${p.name}"`)
  ].join('\n')
}

const HELP_TEXT = `Cookrew — an open-source spatial workspace for AI agents.

Usage:
  cookrew list                                  List connected agents, notes, and browsers
  cookrew ask "Agent" "prompt"                  Send a prompt to a connected agent, wait for the reply
  cookrew ask "Agent" --raw "bytes"             Send raw input (\\n Enter, \\t Tab, \\e ESC, \\xNN byte)
  cookrew check "Agent"                         Read the agent's current terminal output
  cookrew note create ["content"]               Create a connected note on the canvas
  cookrew note read "Name" [offset] [limit]     Read a note with line numbers
  cookrew note write "Name" "content"           Replace a note's content
  cookrew note edit "Name" "old" "new"          Replace a substring within a note
  cookrew note delete "Name"                    Remove a connected note (destructive)
  cookrew browser create URL ["Name"]            Create a connected browser browser
  cookrew browser snapshot|click|fill|type|key|navigate|screenshot|evaluate|html|text|info "Browser" ...
  cookrew browser tabs "Browser"                  List the browser's tabs (pages opened by the site land here)
  cookrew browser tab-new "Browser" URL           Open a new tab in the browser
  cookrew browser tab-select|tab-close "Browser" N   Switch to / close tab N
  cookrew connect "From" "To"                   (Orch) Wire two nodes together
  cookrew recruit "Name" [--preset P] [--role R] [--dir PATH]   (Orch) Spawn a teammate
  cookrew dismiss "Name"                        (Orch) Remove a teammate
  cookrew fork "Agent" [--turn N]               (Orch) Fork a NEW agent from a past turn (original untouched)
  cookrew preset list                           List agent presets
  cookrew voice on|off|status                   Spoken replies when an ask completes (macOS say)
  cookrew voice list | set "Name" | rate 200    Pick the voice that talks back, set speed
  cookrew voice say "text"                      Speak now
  cookrew mobile                                Print (and QR) the phone companion URL — dictation + spoken replies
  cookrew workspace list                        List workspaces (* = active)
  cookrew workspace create "Name" --dir PATH    (Orch) New workspace + switch to it
  cookrew workspace switch "Name"               (Orch) Switch workspace — stops the current one's terminals
  cookrew team save ["Name"]                    (Orch) Snapshot the team (nodes, layout, turn histories)
  cookrew team list                             List saved teams
  cookrew team fork [--name N] [--from "Team"]  (Orch) Fork the whole canvas (or a saved team) into a new workspace
  cookrew role save "Agent" "RoleName" --prompt "..."   Save an agent as a reusable role
  cookrew role list                             List saved roles
  cookrew role delete "RoleName"                (Orch) Remove a saved role
  cookrew notify "message"                      (Orch) Desktop notification`
