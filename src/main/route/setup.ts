import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { HarnessRow, RouteSetupLines } from '../../shared/route'

/**
 * THE LINES THE SETUP TERMINAL TYPES, AND THE HARNESS ROWS (route program).
 *
 * Cookrew draws no form for keys and accounts: the owner types each line
 * into a terminal card and reads magpie's own answer (design §8, "terminal
 * first"). The lines are magpie's CLI as it stood on 2026-10-11 (0.1.1182,
 * `magpie --help`): `autostart on` exists, so the gateway comes up with the
 * login rather than a backgrounded `serve`; `plugin add` takes a path;
 * `accounts add codex` signs a subscription in; `provider add <preset>
 * <key>` takes the key as its second word, so the line ends in a space and
 * the owner pastes.
 *
 * A harness row says what the owner's machine has: the binary on PATH, a
 * sign-in where the harness keeps one (a file; for claude also the macOS
 * Keychain, which a native install uses), and whether the dock offers it.
 * The scan is CACHED for 30 s (HarnessScan): a GET /api/route must not walk
 * PATH and fork `security` every time a phone polls.
 */

export const INSTALL_LINE = 'curl -fsSL https://usemagpie.ai/install.sh | sh'
/** The bare stem the renderer appends a preset to and the user pastes a key after: one trailing space. */
export const ADD_KEY_STEM = 'magpie provider add '

export function setupLines(pluginDir: string): RouteSetupLines {
  return {
    installLine: INSTALL_LINE,
    serveLine: 'magpie autostart on',
    // Single-quoted: a packaged path can hold a space ("Cookrew Dev.app").
    pluginLine: `magpie plugin add '${pluginDir.replace(/'/g, `'\\''`)}'`,
    addSubscriptionLine: 'magpie accounts add codex',
    addKeyLine: (preset: string) => (preset === '' ? ADD_KEY_STEM : `${ADD_KEY_STEM}${preset} `),
    addLocalLine: 'magpie provider add ollama',
    addGroupLine: null
  }
}

/** The group line with the first two catalog models filled in; null below two — never a placeholder. */
export function groupLineFor(modelIds: readonly string[]): string | null {
  const members = modelIds.filter((id) => !id.startsWith('group/')).slice(0, 2)
  return members.length === 2 ? `magpie group add smart models=${members.join(',')} routing=smart` : null
}

export interface HarnessFacts {
  id: HarnessRow['id']
  name: string
  bin: string
  installLine: string
  loginLine: string | null
  /** Files whose presence means "signed in"; null = nothing readable. */
  signInFiles: ((home: string) => string[]) | null
}

export const HARNESS_FACTS: readonly HarnessFacts[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', installLine: 'npm i -g @anthropic-ai/claude-code', loginLine: 'claude', signInFiles: (home) => [path.join(home, '.claude', '.credentials.json')] },
  { id: 'codex', name: 'Codex', bin: 'codex', installLine: 'npm i -g @openai/codex', loginLine: 'codex login', signInFiles: (home) => [path.join(home, '.codex', 'auth.json')] },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', installLine: 'curl -fsSL https://opencode.ai/install | bash', loginLine: 'opencode auth login', signInFiles: (home) => [path.join(home, '.local', 'share', 'opencode', 'auth.json')] },
  { id: 'pi', name: 'Pi', bin: 'pi', installLine: 'npm i -g @earendil-works/pi-coding-agent', loginLine: null, signInFiles: null }
]

/** `which`, by hand: the first PATH entry holding an executable of that name. */
export function onPath(bin: string, pathEnv: string | undefined): boolean {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue
    if (existsSync(path.join(dir, bin))) return true
  }
  return false
}

/** The Keychain item claude's native install keeps its sign-in in; the item's PRESENCE is asked for, never its secret (no -w). */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

export function probeClaudeKeychain(timeoutMs = 2000): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], { timeout: timeoutMs }, (error) => resolve(error === null))
  })
}

export interface HarnessScanDeps {
  home: string
  pathEnv: string | undefined
  /** The dock's presets, by command, so "in dock" is what the owner sees. */
  dockCommands: () => readonly string[]
  harnessOfCommand: (command: string) => HarnessRow['id'] | null
  /** Injected for tests: the Keychain probe (async, bounded), the file check, `which`. */
  keychain?: () => Promise<boolean>
  exists?: (file: string) => boolean
  installed?: (bin: string) => boolean
  now?: () => number
  ttlMs?: number
}

export const SCAN_TTL_MS = 30_000

/**
 * The harness rows, cached. `rows()` answers at once from the last scan and
 * starts a fresh one when it is older than the TTL; the Keychain probe is
 * async and lands in the cache when it returns, so the row it feeds reads
 * false until then and true from the next read on.
 */
export class HarnessScan {
  private rowsCache: HarnessRow[] | null = null
  private scannedAt = 0
  private keychainSignedIn = false
  private probing: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: HarnessScanDeps) {}

  rows(): HarnessRow[] {
    const now = (this.deps.now ?? Date.now)()
    if (this.rowsCache === null || now - this.scannedAt >= (this.deps.ttlMs ?? SCAN_TTL_MS)) {
      this.scannedAt = now
      this.rowsCache = this.scan()
      void this.probeKeychain()
    }
    return this.rowsCache
  }

  /** The scan with the Keychain answer in hand (tests, and a panel that can wait). */
  async rowsSettled(): Promise<HarnessRow[]> {
    this.rows()
    await this.probing
    return this.rowsCache ?? []
  }

  dispose(): void {
    this.disposed = true
  }

  private scan(): HarnessRow[] {
    const exists = this.deps.exists ?? existsSync
    const installed = this.deps.installed ?? ((bin: string) => onPath(bin, this.deps.pathEnv))
    const inDock = new Set(this.deps.dockCommands().map((c) => this.deps.harnessOfCommand(c)).filter((id) => id !== null))
    return HARNESS_FACTS.map((h) => {
      let signedIn: boolean | null = null
      if (h.signInFiles) {
        signedIn = h.signInFiles(this.deps.home).some((f) => exists(f))
        if (!signedIn && h.id === 'claude') signedIn = this.keychainSignedIn
      }
      return { id: h.id, name: h.name, installed: installed(h.bin), signedIn, inDock: inDock.has(h.id), installLine: h.installLine, loginLine: h.loginLine }
    })
  }

  private probeKeychain(): Promise<void> {
    if (this.probing) return this.probing
    const probe = this.deps.keychain ?? (() => probeClaudeKeychain())
    this.probing = probe()
      .then((found) => {
        if (this.disposed) return
        if (found !== this.keychainSignedIn) {
          this.keychainSignedIn = found
          this.rowsCache = this.scan()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.probing = null
      })
    return this.probing
  }
}

/** One scan, uncached — for callers that want a plain function (tests). */
export function harnessRows(deps: HarnessScanDeps & { claudeKeychain?: () => boolean }): HarnessRow[] {
  const scan = new HarnessScan({ ...deps, keychain: async () => deps.claudeKeychain?.() ?? false })
  const rows = scan.rows()
  if (deps.claudeKeychain?.()) {
    return rows.map((r) => (r.id === 'claude' && !r.signedIn ? { ...r, signedIn: true } : r))
  }
  return rows
}
