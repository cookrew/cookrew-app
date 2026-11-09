// THE PROMPT'S WORDS RUN AS THEY ARE (owner, 2026-11-09): `cookrew note "Name"`.
import { describe, expect, it } from 'vitest'
import { bareBrowserHint, bareNoteArgs } from '../src/main/bare-card'

describe('a bare note name', () => {
  it('reads the note', () => {
    expect(bareNoteArgs(['screening-config'])).toEqual(['read', 'screening-config'])
  })

  it('leaves the verbs, and a note with nothing named, as they were', () => {
    expect(bareNoteArgs(['create'])).toEqual(['create'])
    expect(bareNoteArgs(['read', 'Plan'])).toEqual(['read', 'Plan'])
    expect(bareNoteArgs([])).toEqual([])
  })
})

describe('a bare browser name', () => {
  it('names the verbs with the card in them', () => {
    const hint = bareBrowserHint(['localhost:5173'])
    expect(hint).toContain('cookrew browser snapshot "localhost:5173"')
    expect(hint).toContain('screenshot, tap')
  })

  it('says nothing when a verb leads', () => {
    expect(bareBrowserHint(['snapshot'])).toBeNull()
    expect(bareBrowserHint(['create'])).toBeNull()
    expect(bareBrowserHint(['snapshot', 'Docs'])).toBeNull()
    expect(bareBrowserHint([])).toBeNull()
  })
})
