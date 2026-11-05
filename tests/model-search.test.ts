// THE ONE MODEL LIST, FOLDED OR SEARCHED (owner 2026-11-04): 84 rows was too long.

import { describe, expect, it } from 'vitest'
import { modelRows, visibleModelRows } from '../src/shared/model-pick'

const CHOICES = [
  'direct', 'group/smart',
  'auto/gpt-6.1-sol', 'auto/gpt-6-luna', 'openai/gpt-6.1-terra', 'openai/gpt-5', 'deepseek/deepseek-flash',
  'claude/claude-haiku-5-5', 'claude/claude-sonnet-5-5', 'claude/claude-opus-5-5', 'claude/claude-fable-5-1',
  'claude/claude-opus-5', 'claude/claude-opus-4-8', 'claude/claude-opus-4-5-20251101', 'claude/claude-haiku-4-5'
]
const ROWS = modelRows(CHOICES, ['opus', 'sonnet'])
const values = (v: { rows: { value: string }[] }) => v.rows.map((r) => r.value)

describe('folded', () => {
  it('shows the newest claude per family, the groups, one model per provider and direct', () => {
    const v = visibleModelRows(ROWS, {})
    expect(values(v)).toEqual([
      'claude/claude-haiku-5-5', 'claude/claude-sonnet-5-5', 'claude/claude-opus-5-5', 'claude/claude-fable-5-1',
      'group/smart',
      'auto/gpt-6.1-sol', 'openai/gpt-6.1-terra', 'deepseek/deepseek-flash',
      'direct:opus', 'direct:sonnet'
    ])
    expect(v.hidden).toBe(ROWS.length - v.rows.length)
  })

  it('never hides the row the card stands on, or one it was asked to move to', () => {
    const v = visibleModelRows(ROWS, { keep: ['claude/claude-opus-4-8', 'openai/gpt-5', null] })
    expect(values(v)).toContain('claude/claude-opus-4-8')
    expect(values(v)).toContain('openai/gpt-5')
  })

  it('unfolds to every row', () => {
    expect(visibleModelRows(ROWS, { all: true })).toEqual({ rows: ROWS, hidden: 0 })
  })
})

describe('searched', () => {
  it('searches every row, each word in the id, folded or not', () => {
    expect(values(visibleModelRows(ROWS, { query: 'opus 4' }))).toEqual(['claude/claude-opus-4-8', 'claude/claude-opus-4-5-20251101'])
    expect(values(visibleModelRows(ROWS, { query: ' GPT-6 ' }))).toEqual(['auto/gpt-6.1-sol', 'auto/gpt-6-luna', 'openai/gpt-6.1-terra'])
    expect(values(visibleModelRows(ROWS, { query: 'direct son' }))).toEqual(['direct:sonnet'])
    expect(visibleModelRows(ROWS, { query: 'nothing-like-it' })).toEqual({ rows: [], hidden: 0 })
  })
})
