import { describe, expect, it } from 'vitest'
import { isCodexCommand } from '../src/shared/codex-command'

describe('isCodexCommand', () => {
  it('is a line that runs codex', () => {
    expect(isCodexCommand('codex')).toBe(true)
    expect(isCodexCommand('  codex -m auto/gpt-6.1-sol')).toBe(true)
    expect(isCodexCommand('codex -c tui.alternate_screen=never resume abc')).toBe(true)
  })
  it('and nothing else', () => {
    expect(isCodexCommand('claude --resume x')).toBe(false)
    expect(isCodexCommand('opencode')).toBe(false)
    expect(isCodexCommand('')).toBe(false)
  })
})
