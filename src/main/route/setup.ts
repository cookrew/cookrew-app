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
 * sign-in file where the harness keeps one (null where it keeps none we can
 * read), and whether the dock already offers it.
 */

export const INSTALL_LINE = 'curl -fsSL https://usemagpie.ai/install.sh | sh'

export function setupLines(pluginDir: string): RouteSetupLines {
  return {
    installLine: INSTALL_LINE,
    serveLine: 'magpie autostart on',
    pluginLine: `magpie plugin add ${pluginDir}`,
    addSubscriptionLine: 'magpie accounts add codex',
    addKeyLine: (preset: string) => `magpie provider add ${preset} `,
    addLocalLine: 'magpie provider add ollama',
    addGroupLine: 'magpie group add smart models=<model-1>,<model-2> routing=smart'
  }
}

/** The group line with the first two catalog ids filled in, when there are two. */
export function groupLineFor(modelIds: readonly string[]): string {
  const members = modelIds.filter((id) => !id.startsWith('group/')).slice(0, 2)
  return members.length === 2
    ? `magpie group add smart models=${members.join(',')} routing=smart`
    : setupLines('').addGroupLine
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
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    installLine: 'npm i -g @anthropic-ai/claude-code',
    loginLine: 'claude',
    signInFiles: (home) => [path.join(home, '.claude', '.credentials.json')]
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    installLine: 'npm i -g @openai/codex',
    loginLine: 'codex login',
    signInFiles: (home) => [path.join(home, '.codex', 'auth.json')]
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    installLine: 'curl -fsSL https://opencode.ai/install | bash',
    loginLine: 'opencode auth login',
    signInFiles: (home) => [path.join(home, '.local', 'share', 'opencode', 'auth.json')]
  },
  {
    id: 'pi',
    name: 'Pi',
    bin: 'pi',
    installLine: 'npm i -g @earendil-works/pi-coding-agent',
    loginLine: null,
    signInFiles: null
  }
]

/** `which`, by hand: the first PATH entry holding an executable of that name. */
export function onPath(bin: string, pathEnv: string | undefined): boolean {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue
    if (existsSync(path.join(dir, bin))) return true
  }
  return false
}

export interface HarnessRowDeps {
  home: string
  pathEnv: string | undefined
  /** The dock's presets, by command, so "in dock" is what the owner sees. */
  dockCommands: () => readonly string[]
  harnessOfCommand: (command: string) => HarnessRow['id'] | null
  /** Claude keeps its sign-in in the Keychain on macOS; a caller that can ask says so. */
  claudeKeychain?: () => boolean
  exists?: (file: string) => boolean
  installed?: (bin: string) => boolean
}

export function harnessRows(deps: HarnessRowDeps): HarnessRow[] {
  const exists = deps.exists ?? existsSync
  const installed = deps.installed ?? ((bin: string) => onPath(bin, deps.pathEnv))
  const inDock = new Set(deps.dockCommands().map((c) => deps.harnessOfCommand(c)).filter((id) => id !== null))
  return HARNESS_FACTS.map((h) => {
    let signedIn: boolean | null = null
    if (h.signInFiles) {
      signedIn = h.signInFiles(deps.home).some((f) => exists(f))
      if (!signedIn && h.id === 'claude' && deps.claudeKeychain) signedIn = deps.claudeKeychain()
    }
    return {
      id: h.id,
      name: h.name,
      installed: installed(h.bin),
      signedIn,
      inDock: inDock.has(h.id),
      installLine: h.installLine,
      loginLine: h.loginLine
    }
  })
}
