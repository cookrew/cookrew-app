import { describe, expect, it } from 'vitest'
import {
  shouldClearLegacyThumbs,
  shouldPollThumbs,
  shouldSnapshotLocally
} from '../src/renderer/src/browser-thumb-policy'

describe('browser thumbnail source policy', () => {
  it('polls main from the phone with headless browsers on — the bug', () => {
    // The phone showed a placeholder on every browser card because this was
    // gated to flag-off clients only.
    expect(shouldPollThumbs({ remote: true, interactive: true })).toBe(true)
  })

  it('polls main from the phone with legacy webviews too', () => {
    expect(shouldPollThumbs({ remote: true, interactive: false })).toBe(true)
  })

  it('waits until ownership is known before asking for a frame', () => {
    expect(shouldPollThumbs({ remote: true, interactive: null })).toBe(false)
  })

  it('never polls from the desktop — it produces the frames', () => {
    expect(shouldPollThumbs({ remote: false, interactive: true })).toBe(false)
    expect(shouldPollThumbs({ remote: false, interactive: false })).toBe(false)
  })

  it('snapshots the local headless page only on the desktop, flag on', () => {
    expect(shouldSnapshotLocally({ remote: false, interactive: true })).toBe(true)
    expect(shouldSnapshotLocally({ remote: false, interactive: false })).toBe(false)
    expect(shouldSnapshotLocally({ remote: false, interactive: null })).toBe(false)
    expect(shouldSnapshotLocally({ remote: true, interactive: true })).toBe(false)
  })

  it('clears retained frames on the desktop only — a phone would wipe its own', () => {
    expect(shouldClearLegacyThumbs({ remote: false, interactive: true })).toBe(true)
    expect(shouldClearLegacyThumbs({ remote: true, interactive: true })).toBe(false)
    expect(shouldClearLegacyThumbs({ remote: false, interactive: false })).toBe(false)
  })
})
