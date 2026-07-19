import { describe, expect, it } from 'vitest'
import { buildTitlePrompt, sanitizeTitle, TITLE_MAX_CHARS } from '../src/shared/sous'

describe('buildTitlePrompt', () => {
  it('includes the user prompt, recent tools and output tail', () => {
    const prompt = buildTitlePrompt({
      prompt: 'fix the login bug',
      tools: ['Read(auth.ts)', 'Edit(auth.ts)'],
      lines: ['Looking at the token check…', 'Found the expiry comparison bug']
    })
    expect(prompt).toContain('fix the login bug')
    expect(prompt).toContain('Edit(auth.ts)')
    expect(prompt).toContain('Found the expiry comparison bug')
  })

  it('truncates an oversized prompt and output tail', () => {
    const prompt = buildTitlePrompt({
      prompt: 'x'.repeat(2000),
      tools: [],
      lines: Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(60)}`)
    })
    expect(prompt.length).toBeLessThan(3000)
    // The tail keeps the NEWEST lines.
    expect(prompt).toContain('line 399')
  })

  it('omits empty sections instead of rendering blank headers', () => {
    const prompt = buildTitlePrompt({ prompt: 'hello', tools: [], lines: [] })
    expect(prompt).not.toContain('Recent tool calls')
    expect(prompt).not.toContain('Recent output')
  })
})

describe('sanitizeTitle', () => {
  it('trims whitespace and surrounding quotes', () => {
    expect(sanitizeTitle('  "Fixing login token expiry"  ')).toBe('Fixing login token expiry')
    expect(sanitizeTitle('“修复登录令牌过期”')).toBe('修复登录令牌过期')
    expect(sanitizeTitle('`Refactor auth module`')).toBe('Refactor auth module')
  })

  it('keeps only the first non-empty line', () => {
    expect(sanitizeTitle('\nDebugging tests\nSecond line ignored')).toBe('Debugging tests')
  })

  it('strips thinking blocks emitted by reasoning models', () => {
    expect(sanitizeTitle('<think>hmm the agent is…</think>\nRunning test suite')).toBe(
      'Running test suite'
    )
  })

  it('strips label prefixes and trailing sentence punctuation', () => {
    expect(sanitizeTitle('Title: Updating CI config.')).toBe('Updating CI config')
    expect(sanitizeTitle('标题：升级依赖。')).toBe('升级依赖')
  })

  it('caps overlong titles with an ellipsis', () => {
    const long = 'w'.repeat(TITLE_MAX_CHARS + 20)
    const out = sanitizeTitle(long)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('returns null for empty or punctuation-only output', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   \n  ')).toBeNull()
    expect(sanitizeTitle('"…"')).toBeNull()
    expect(sanitizeTitle('<think>only thoughts</think>')).toBeNull()
  })
})
