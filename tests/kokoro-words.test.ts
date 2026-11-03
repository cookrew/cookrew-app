import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sayableText, supplementLexicon } = require('../scripts/local-voice/kokoro-words.cjs') as {
  sayableText: (text: string, known: (w: string) => boolean) => string
  supplementLexicon: () => string
}

const LEXICON = new Set(['merged', 'into', 'the', 'prompt', 'extras', 'work', 'tree', 'use', 'thing', 'server', 'ok', 'it', "it's", 'done', 'speak', 'able', 'git', 'and'])
const known = (w: string): boolean => LEXICON.has(w)

describe('English the Kokoro voice can say', () => {
  it('a word it knows is kept, lowercased', () => {
    expect(sayableText('Merged into the Git tree', known)).toBe('merged into the git tree')
  })

  it('a word it lacks but the supplement has is kept', () => {
    expect(sayableText('merged into dev', known)).toBe('merged into dev')
  })

  it('camelCase splits; short capitals are spelled', () => {
    expect(sayableText('PromptExtras', known)).toBe('prompt extras')
    expect(sayableText('useThing', known)).toBe('use thing')
    expect(sayableText('the API and CDP', known)).toBe('the a p i and c d p')
    expect(sayableText('HTTPServer', known)).toBe('h t t p server')
  })

  it('an unknown compound splits into known words', () => {
    expect(sayableText('worktree speakable', known)).toBe('work tree speak able')
  })

  it('a supplement word in capitals is said, not spelled', () => {
    expect(sayableText('the JSON and TODO list', (w) => known(w) || w === 'list')).toBe('the json and todo list')
  })

  it('a short unknown is spelled, a long one left alone', () => {
    expect(sayableText('xq', known)).toBe('x q')
    expect(sayableText('zzyzxville', known)).toBe('zzyzxville')
  })

  it('Chinese, digits and punctuation are untouched', () => {
    expect(sayableText('合入 dev 了，测试 83 个通过。', known)).toBe('合入 dev 了，测试 83 个通过。')
  })

  it("an apostrophe word it knows stays whole", () => {
    expect(sayableText("It's done", known)).toBe("it's done")
  })

  it('the supplement is lexicon lines: word, then its phonemes', () => {
    for (const line of supplementLexicon().trim().split('\n')) expect(line).toMatch(/^[a-z]+( \S+)+$/)
  })
})
