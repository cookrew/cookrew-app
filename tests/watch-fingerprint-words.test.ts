// The watch speaks a key's words from the very list the Mac and the page do:
// watch/Sources/CookrewCore/FingerprintWords.swift is generated from it
// (scripts/watch-fingerprint-words.mjs), and this says the two are one list.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_WORDS } from '../src/shared/fingerprint-words'

describe('the watch\'s fingerprint words', () => {
  it('are the shared list, word for word, in order', () => {
    const swift = readFileSync('watch/Sources/CookrewCore/FingerprintWords.swift', 'utf8')
    expect([...swift.matchAll(/"([a-z]+)"/g)].map((match) => match[1])).toEqual([...FINGERPRINT_WORDS])
  })
})
