// THE SETTINGS JUMP: macOS lists an app only once it has asked, so the jump
// must ask. Electron cannot say whether it was ever asked: a real never-asked
// bundle reads `denied` for the screen and `not-determined` for the camera.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ order: [] as string[], getSources: vi.fn(), openExternal: vi.fn(), trusted: vi.fn() }))

vi.mock('electron', () => ({
  clipboard: {},
  screen: {},
  desktopCapturer: { getSources: calls.getSources },
  shell: { openExternal: calls.openExternal },
  systemPreferences: { isTrustedAccessibilityClient: calls.trusted }
}))

import { openAccessibilitySettings, openScreenRecordingSettings } from '../src/main/use-source-electron'

beforeEach(() => {
  calls.order.length = 0
  calls.getSources.mockReset().mockImplementation(async () => {
    calls.order.push('ask')
    return []
  })
  calls.openExternal.mockReset().mockImplementation(async () => {
    calls.order.push('open')
  })
  calls.trusted.mockReset().mockReturnValue(false)
})

describe('openScreenRecordingSettings', () => {
  it('asks when the status reads denied: that is what a Mac that was never asked answers', async () => {
    await openScreenRecordingSettings('denied')
    expect(calls.order).toEqual(['ask', 'open'])
  })

  it('asks before opening, so the page has a row to show', async () => {
    await openScreenRecordingSettings('not-determined')
    expect(calls.order).toEqual(['ask', 'open'])
  })

  it('never captures for a grant it already has', async () => {
    await openScreenRecordingSettings('granted')
    expect(calls.order).toEqual(['open'])
  })

  it('a failed ask still opens the page', async () => {
    calls.getSources.mockRejectedValue(new Error('capture failed'))
    await openScreenRecordingSettings('denied')
    expect(calls.order).toEqual(['open'])
  })
})

describe('openAccessibilitySettings', () => {
  it('prompts, which is what makes the row, then opens the page', async () => {
    await openAccessibilitySettings()
    expect(calls.trusted).toHaveBeenCalledWith(true)
    expect(calls.order).toEqual(['open'])
  })
})
