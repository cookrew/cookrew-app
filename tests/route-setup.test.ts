// THE SETUP LINES AS THE PANEL TYPES THEM (round 4, from the panel lane's
// verification): the key line is a bare stem the renderer completes, the
// plugin path is single-quoted because a packaged path may hold a space, and
// the group line is null below two catalog models — never a placeholder.

import { describe, expect, it } from 'vitest'
import { ADD_KEY_STEM, groupLineFor, setupLines } from '../src/main/route/setup'

describe('setup lines', () => {
  it('the key line is the bare stem with exactly one trailing space; a preset lands between', () => {
    expect(ADD_KEY_STEM).toBe('magpie provider add ')
    expect(setupLines('/x').addKeyLine('')).toBe('magpie provider add ')
    expect(setupLines('/x').addKeyLine('deepseek')).toBe('magpie provider add deepseek ')
  })

  it("the plugin path is single-quoted, so a space in a packaged path survives the shell", () => {
    expect(setupLines('/Applications/Cookrew Dev.app/Contents/Resources/magpie').pluginLine).toBe(
      "magpie plugin add '/Applications/Cookrew Dev.app/Contents/Resources/magpie'"
    )
    expect(setupLines('/app/resources/magpie').pluginLine).toMatch(/^magpie plugin add '[A-Za-z0-9._/@~ -]+'$/)
  })

  it('the group line needs two non-group models, else null', () => {
    expect(setupLines('/x').addGroupLine).toBeNull()
    expect(groupLineFor([])).toBeNull()
    expect(groupLineFor(['group/smart', 'ollama/qwen3'])).toBeNull()
    expect(groupLineFor(['group/smart', 'ollama/qwen3', 'claude/claude-opus-5-5', 'deepseek/deepseek-chat'])).toBe(
      'magpie group add smart models=ollama/qwen3,claude/claude-opus-5-5 routing=smart'
    )
  })
})
