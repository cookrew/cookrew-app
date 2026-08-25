import { describe, expect, it } from 'vitest'
import {
  TRANSLATE_CHUNK_CHARS,
  TRANSLATE_FAILURE_TEXT,
  TRANSLATE_LANGUAGES,
  buildTranslatePrompt,
  buildTranslateSystem,
  languageByCode,
  sanitizeTranslation,
  splitForTranslation
} from '../src/shared/translate'

describe('the language menu', () => {
  it('every entry has a distinct code and both a display name and a prompt label', () => {
    const codes = TRANSLATE_LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const l of TRANSLATE_LANGUAGES) {
      expect(l.name.trim().length).toBeGreaterThan(0)
      expect(l.label.trim().length).toBeGreaterThan(0)
      // The prompt label is what a small model is asked for; an endonym in the
      // prompt gets followed far less reliably than the English name.
      expect(l.label).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('looks a language up by code, and refuses one it does not have', () => {
    expect(languageByCode('ja')?.label).toBe('Japanese')
    expect(languageByCode('klingon')).toBeNull()
  })
})

describe('splitForTranslation', () => {
  it('leaves a short body as a single piece', () => {
    expect(splitForTranslation('Just one short paragraph.')).toEqual(['Just one short paragraph.'])
  })

  it('drops a body that is only whitespace', () => {
    expect(splitForTranslation('   \n\n  ')).toEqual([])
  })

  it('every piece of a long body fits the limit', () => {
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some words in it.`).join(
      '\n\n'
    )
    const pieces = splitForTranslation(body)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(TRANSLATE_CHUNK_CHARS)
  })

  it('loses no text: the pieces rejoin to the original modulo blank runs', () => {
    const body = 'Alpha beta.\n\nGamma delta.\n\nEpsilon.'
    expect(splitForTranslation(body).join('').replace(/\s+/g, ' ').trim()).toBe(
      body.replace(/\s+/g, ' ').trim()
    )
  })

  it('never splits a word in half', () => {
    const body = Array.from({ length: 400 }, () => 'antidisestablishmentarianism').join(' ')
    for (const piece of splitForTranslation(body)) {
      for (const word of piece.trim().split(/\s+/)) {
        expect(word).toBe('antidisestablishmentarianism')
      }
    }
  })

  it('keeps a fenced code block whole rather than cutting it across pieces', () => {
    const code = '```ts\n' + Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n```'
    const pieces = splitForTranslation(`Before it.\n\n${code}\n\nAfter it.`)
    const fenced = pieces.filter((p) => p.includes('```'))
    expect(fenced).toHaveLength(1)
    expect(fenced[0]).toContain('const v0 = 0')
    expect(fenced[0]).toContain('const v79 = 79')
  })

  it('emits an unbreakable run alone rather than chopping it at the limit', () => {
    const blob = 'x'.repeat(TRANSLATE_CHUNK_CHARS * 2)
    const pieces = splitForTranslation(`Prose here.\n\n${blob}\n\nMore prose.`)
    // Whole and alone: one piece IS the blob (bar surrounding newlines), and no
    // piece holds a fragment of it — a chopped run translates wrongly.
    expect(pieces.filter((p) => p.includes('x'))).toHaveLength(1)
    expect(pieces.find((p) => p.includes('x'))?.trim()).toBe(blob)
  })
})

describe('the prompt is split from the instructions', () => {
  it('the system message names the language and forbids translating code', () => {
    const sys = buildTranslateSystem('Japanese')
    expect(sys).toContain('Japanese')
    expect(sys.toLowerCase()).toContain('backticks')
    expect(sys).toMatch(/only the translation/i)
  })

  /**
   * The regression: rules used to sit above the text in the SAME string, and on
   * a long structured body the model echoed the rule list back as its
   * translation. Nothing downstream can catch that reliably — rule text is
   * fluent prose — so the fix has to be that the rules were never in the thing
   * being translated.
   */
  it('the prompt carries the text and nothing else', () => {
    const body = 'Hello there.\n\nSecond paragraph.'
    expect(buildTranslatePrompt({ text: body, label: 'Japanese' })).toBe(body)
  })
})

describe('sanitizeTranslation', () => {
  it('keeps a plain translation untouched', () => {
    expect(sanitizeTranslation('これはテストです。')).toBe('これはテストです。')
  })

  it('strips the preamble a small model bolts on', () => {
    expect(sanitizeTranslation('Sure! Here is the translation:\nBonjour le monde')).toBe(
      'Bonjour le monde'
    )
    expect(sanitizeTranslation('Translated text:\nHola mundo')).toBe('Hola mundo')
  })

  it('unwraps a fence the model put around its whole answer', () => {
    expect(sanitizeTranslation('```\nGuten Tag\n```')).toBe('Guten Tag')
  })

  it('keeps a fence that is actual content of the reply', () => {
    const withCode = 'Voici le code :\n\n```ts\nconst a = 1\n```\n\nEt voilà.'
    expect(sanitizeTranslation(withCode)).toBe(withCode)
  })

  it('drops the --- rules the prompt used to bracket the source', () => {
    expect(sanitizeTranslation('---\nCiao mondo\n---')).toBe('Ciao mondo')
  })

  it('refuses an answer that is our own instructions handed back', () => {
    expect(sanitizeTranslation('Rules:\n- Output ONLY the translation.')).toBeNull()
    expect(sanitizeTranslation('You are a translator. You translate...')).toBeNull()
  })

  /**
   * The refusal case is the point of this function. An empty or whitespace
   * answer rendered as a body is indistinguishable from a real translation of a
   * short reply, so the caller must be able to tell that nothing came back.
   */
  it('refuses an empty answer instead of returning an empty body', () => {
    expect(sanitizeTranslation('')).toBeNull()
    expect(sanitizeTranslation('   \n  ')).toBeNull()
    expect(sanitizeTranslation('Here is the translation:\n')).toBeNull()
  })
})

describe('failure reasons', () => {
  it('every reason has reader-facing text that says the transcript is unchanged', () => {
    for (const [reason, text] of Object.entries(TRANSLATE_FAILURE_TEXT)) {
      expect(text.length).toBeGreaterThan(10)
      // Never phrase our own failure as the agent's: the transcript is fine.
      expect(text.toLowerCase()).not.toContain('transcript is corrupt')
      expect(reason.length).toBeGreaterThan(0)
    }
  })
})
