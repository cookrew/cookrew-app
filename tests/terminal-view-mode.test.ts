import { describe, expect, it } from 'vitest'
import { shouldAttachTerminal } from '../src/renderer/src/terminal-view-mode'

describe('shouldAttachTerminal', () => {
  it('keeps CHAT and LOG record views mirrorless', () => {
    expect(shouldAttachTerminal('chat')).toBe(false)
    expect(shouldAttachTerminal('log')).toBe(false)
  })

  it('attaches only for LIVE', () => {
    expect(shouldAttachTerminal('live')).toBe(true)
  })
})
