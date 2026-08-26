import { describe, expect, it } from 'vitest'
import { looksUntranslated } from '../src/shared/translate-check'

const ENGLISH =
  'The code-reviewer pass found that servedSpawn forwarded grantedKeys unvalidated, so a granted HOME would override the sandbox scrub entirely.'

describe('looksUntranslated', () => {
  it('catches the answer coming back in the source language', () => {
    expect(looksUntranslated(ENGLISH, ENGLISH, 'zh-Hans')).toBe(true)
    expect(looksUntranslated(ENGLISH, ENGLISH, 'ja')).toBe(true)
    expect(looksUntranslated(ENGLISH, ENGLISH, 'hi')).toBe(true)
    expect(looksUntranslated(ENGLISH, ENGLISH, 'ru')).toBe(true)
  })

  it('accepts a real translation in each script it knows', () => {
    expect(looksUntranslated(ENGLISH, '代码审查发现了一个问题，需要修复。', 'zh-Hans')).toBe(false)
    expect(looksUntranslated(ENGLISH, 'コードレビューで問題が見つかりました。', 'ja')).toBe(false)
    expect(looksUntranslated(ENGLISH, '코드 검토에서 문제를 발견했습니다.', 'ko')).toBe(false)
    expect(looksUntranslated(ENGLISH, 'कोड समीक्षा में एक समस्या मिली।', 'hi')).toBe(false)
    expect(looksUntranslated(ENGLISH, 'Проверка кода выявила проблему.', 'ru')).toBe(false)
  })

  /**
   * A translation that keeps identifiers and paths in Latin is CORRECT — that
   * is what the system prompt asks for — so the presence of English is not the
   * signal. The absence of any target-script character is.
   */
  it('accepts a translation that keeps code and paths in Latin', () => {
    expect(
      looksUntranslated(ENGLISH, '运行 `npm run build`，然后打开 `out/renderer/index.html`。', 'zh-Hans')
    ).toBe(false)
  })

  it('says nothing about a Latin-script target, where it has no signal', () => {
    // Spanish output and English output are both Latin: there is no evidence
    // here either way, so it must not claim there is.
    expect(looksUntranslated(ENGLISH, ENGLISH, 'es')).toBe(false)
    expect(looksUntranslated(ENGLISH, 'El revisor encontró un problema.', 'es')).toBe(false)
  })

  it('leaves short pieces alone — they can legitimately come back unchanged', () => {
    expect(looksUntranslated('out/renderer/index.html', 'out/renderer/index.html', 'ja')).toBe(false)
    expect(looksUntranslated('## State', '## State', 'zh-Hans')).toBe(false)
  })

  it('says nothing about a language it does not offer', () => {
    expect(looksUntranslated(ENGLISH, ENGLISH, 'klingon')).toBe(false)
  })
})
