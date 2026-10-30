// TWO WAYS TO READ A TRANSCRIPT (renderer/transcript-look.ts,
// transcript-paper.css): chat by default, one choice shared by every card,
// and the chat's styles confined to the chat look so the live look reads as
// it did before the chat.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TRANSCRIPT_LOOK_KEY, setTranscriptLook, transcriptLookOf } from '../src/renderer/src/transcript-look'

describe('transcriptLookOf', () => {
  it('is chat unless live was chosen', () => {
    expect(transcriptLookOf(null)).toBe('chat')
    expect(transcriptLookOf('chat')).toBe('chat')
    expect(transcriptLookOf('live')).toBe('live')
    expect(transcriptLookOf('board')).toBe('chat')
  })
})

describe('setTranscriptLook', () => {
  it('remembers the choice', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } })
    setTranscriptLook('live')
    expect(store.get(TRANSCRIPT_LOOK_KEY)).toBe('live')
    vi.unstubAllGlobals()
  })
})

describe('transcript-paper.css', () => {
  const css = readFileSync(path.join(__dirname, '../src/renderer/src/transcript-paper.css'), 'utf8')
  const chat = css.slice(css.indexOf('THE TRANSCRIPT AS A CHAT'), css.indexOf('THE LIVE LOOK'))

  it('scopes every chat rule to the chat look', () => {
    const selectors = chat.match(/\.lod-overlay [^{]*\{/g) ?? []
    expect(selectors.length).toBeGreaterThan(10)
    for (const one of selectors) for (const part of one.replace('{', '').split(',')) expect(part.trim(), part).toMatch(/^\.lod-overlay \.look-chat /)
  })

  it('the live look dissolves the chat wrappers and hides the face', () => {
    const live = css.slice(css.indexOf('THE LIVE LOOK'))
    expect(live).toMatch(/\.look-live \.ctx-chat-agent,[\s\S]*\.look-live \.ctx-chat-bubble,[\s\S]*\.look-live \.ctx-chat-tools \{\s*display: contents;/)
    expect(live).toMatch(/\.look-live \.ctx-chat-face \{\s*display: none;/)
  })
})
