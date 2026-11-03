import { describe, expect, it } from 'vitest'
import { SPEAK_MAX_CHARS, speakableText, speechChunks } from '../src/shared/speakable'

describe('speakableText: a reply as it is heard, not as it is drawn', () => {
  it('drops fenced code and keeps the words around it', () => {
    const md = 'Fixed it.\n\n```ts\nconst a = 1\n```\n\nTests pass.'
    expect(speakableText(md)).toBe('Fixed it. Tests pass.')
  })

  it('unwraps emphasis, inline code, headings, quotes and links', () => {
    const md = '## Result\n> **Done**: renamed `useThing` — see [the PR](https://github.com/o/r/pull/1).'
    expect(speakableText(md)).toBe('Result. Done: renamed useThing — see the PR.')
  })

  it('a bare URL is read as its host, a long path as its file name', () => {
    expect(speakableText('Open https://cookrew.dev/me?x=1 now')).toBe('Open cookrew.dev now')
    expect(speakableText('Edited /Users/drej/workspace/app/src/main/voice.ts:42 today')).toBe('Edited voice.ts today')
  })

  it('a list becomes sentences, a Chinese line pauses with a Chinese stop', () => {
    expect(speakableText('- first item\n- second item')).toBe('first item. second item.')
    expect(speakableText('1. 修好了\n2. 测试通过')).toBe('修好了。 测试通过。')
  })

  it('a table is read row by row; rules and glyphs are not read', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n⏺ ok'
    expect(speakableText(md)).toBe('a, b. 1, 2. ok')
  })

  it('snake_case survives; *stars* do not', () => {
    expect(speakableText('set my_var to *on*')).toBe('set my_var to on')
  })

  it('a long reply ends at a sentence, inside the cap', () => {
    const text = speakableText('One sentence here. '.repeat(200))
    expect(text.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS)
    expect(text.endsWith('here.')).toBe(true)
  })

  it('nothing to say is empty', () => {
    expect(speakableText('```\nonly code\n```')).toBe('')
    expect(speakableText('')).toBe('')
  })
})

describe('speechChunks: sentences packed for the voice, the first one short', () => {
  it('a short reply is one chunk', () => {
    expect(speechChunks('Done. All good.')).toEqual(['Done. All good.'])
  })

  it('splits at sentence ends, never inside a file name or a number', () => {
    const chunks = speechChunks('Edited voice.ts and bumped 3.5 to 4. ' + 'More words follow here. '.repeat(20), { first: 40, rest: 120, ramp: 1e9 })
    expect(chunks[0]).toBe('Edited voice.ts and bumped 3.5 to 4.')
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(
      ('Edited voice.ts and bumped 3.5 to 4. ' + 'More words follow here. '.repeat(20)).trim()
    )
  })

  it('splits Chinese at its own stops', () => {
    const chunks = speechChunks('第一句。第二句！第三句？', { first: 4, rest: 8, ramp: 1e9 })
    expect(chunks).toEqual(['第一句。', '第二句！第三句？'])
  })

  it('a sentence longer than a chunk breaks at a comma, else hard', () => {
    const chunks = speechChunks('aaaa, bbbb, cccc, dddd', { first: 12, rest: 12, ramp: 1 })
    expect(chunks).toEqual(['aaaa, bbbb,', 'cccc, dddd'])
    expect(speechChunks('x'.repeat(25), { first: 10, rest: 10, ramp: 1 })).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('chunks grow from a short first one, each at most 2.5 times the last', () => {
    const chunks = speechChunks('Some words here. '.repeat(60))
    expect(chunks[0].length).toBeLessThanOrEqual(36)
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i].length).toBeLessThanOrEqual(Math.min(240, Math.round(36 * 2.5 ** i)))
    expect(Math.max(...chunks.map((c) => c.length))).toBeGreaterThan(200)
  })

  it('nothing gives no chunks', () => {
    expect(speechChunks('   ')).toEqual([])
  })
})
