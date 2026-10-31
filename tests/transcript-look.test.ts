// TWO VIEWS OF AN AGENT (renderer/transcript-look.ts, transcript-paper.css):
// chat by default, one choice shared by every card; chat is the conversation
// alone, live is the raw herdr terminal; and the terminal has the same box in
// both, so switching never resizes the agent's pane.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TRANSCRIPT_LOOK_KEY, isRecordLook, nextLook, setTranscriptLook, transcriptLookOf } from '../src/renderer/src/transcript-look'

describe('transcriptLookOf', () => {
  it('is chat unless live was chosen', () => {
    expect(transcriptLookOf(null)).toBe('chat')
    expect(transcriptLookOf('chat')).toBe('chat')
    expect(transcriptLookOf('live')).toBe('live')
    expect(transcriptLookOf('board')).toBe('chat')
    expect(transcriptLookOf('log')).toBe('log')
  })

  it('cycles chat → log → live → chat; chat and log draw the record', () => {
    expect(nextLook('chat')).toBe('log')
    expect(nextLook('log')).toBe('live')
    expect(nextLook('live')).toBe('chat')
    expect(['chat', 'log', 'live'].map((l) => isRecordLook(l as 'chat'))).toEqual([true, true, false])
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
  const chat = css.slice(css.indexOf('THE TRANSCRIPT AS A CHAT'), css.indexOf('CHAT OR THE RAW TERMINAL'))
  const views = css.slice(css.indexOf('CHAT OR THE RAW TERMINAL'))
  const rule = (selector: string): string => {
    const at = views.indexOf(`${selector} {`)
    return at < 0 ? '' : views.slice(at, views.indexOf('}', at))
  }

  it('scopes every chat rule to the chat look', () => {
    const selectors = chat.match(/\.lod-overlay [^{]*\{/g) ?? []
    expect(selectors.length).toBeGreaterThan(10)
    for (const one of selectors) for (const part of one.replace('{', '').split(',')) expect(part.trim(), part).toMatch(/^\.lod-overlay \.look-chat /)
  })

  it('gives the terminal the same box in both views: the whole transcript area', () => {
    expect(views).toMatch(/\.lod-overlay \.look-records \.ctx-live,\s*\.lod-overlay \.look-live \.ctx-live \{[^}]*position: absolute;[^}]*top: 0;[^}]*height: 100%;/)
  })

  it('in chat and log the terminal is there but unseen and untouchable', () => {
    expect(rule('.lod-overlay .look-records .ctx-live')).toMatch(/visibility: hidden;[\s\S]*pointer-events: none;/)
  })

  it('in live the terminal is all there is', () => {
    expect(rule('.lod-overlay .look-live .ctx-transcript > :not(.ctx-live)')).toMatch(/display: none;/)
  })

  it('the log look is the same rows restyled: wrappers dissolved, no face, terminal markers', () => {
    const log = css.slice(css.indexOf('THE LOG LOOK'))
    expect(log).toMatch(/\.look-log \.ctx-chat-agent,[\s\S]*\.look-log \.ctx-chat-tools \{\s*display: contents;/)
    expect(log).toMatch(/\.look-log \.ctx-chat-face \{\s*display: none;/)
    expect(log).toMatch(/\.look-log \.ctx-tool-call::before,[\s\S]*content: '● ';/)
  })
})

