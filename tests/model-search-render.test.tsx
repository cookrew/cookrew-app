// The one model list's search box and fold, drawn (owner 2026-11-04).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelList, searchHoldsEscape } from '../src/renderer/src/nodes/ModelDial'
import { modelRows } from '../src/shared/model-pick'

const LONG = modelRows([
  'direct', 'group/smart', 'auto/gpt-6.1-sol', 'auto/gpt-6-luna', 'auto/gpt-6-sol',
  ...['5-5', '5', '4-8', '4-7', '4-6', '4-5'].map((v) => `claude/claude-opus-${v}`),
  'claude/claude-sonnet-5-5', 'claude/claude-sonnet-5', 'claude/claude-haiku-5-5'
])

describe('a long list', () => {
  it('heads with a search box and folds to its newest rows, with the rest one click away', () => {
    const html = renderToStaticMarkup(<ModelList rows={LONG} current="claude/claude-opus-4-7" onPick={() => {}} />)
    expect(html).toContain('type="search"')
    expect(html).toContain('placeholder="search models"')
    expect(html).toMatch(/\d+ more models…/)
    // folded, yet the row the card stands on shows
    expect(html).toContain('>claude/claude-opus-4-7<')
    expect(html).not.toContain('>claude/claude-opus-4-6<')
  })

  it('a short one shows whole, with no box', () => {
    const html = renderToStaticMarkup(<ModelList rows={modelRows(['direct', 'group/smart'])} current={null} onPick={() => {}} />)
    expect(html).not.toContain('type="search"')
    expect(html).not.toContain('more models')
  })

  it('keeps Enter from submitting the prompt form, and the keys from the zoom', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nodes', 'ModelDial.tsx'), 'utf8')
    expect(src).toContain("if (e.key === 'Enter') {\n                e.preventDefault()")
    expect(src).toContain('e.stopPropagation()')
  })
})

describe('Esc in the box', () => {
  const box = (value: string) => ({ classList: { contains: (c: string) => c === 'cr-model-search' }, value })
  it('clears its words first; the menu closes on the next', () => {
    expect(searchHoldsEscape({ key: 'Escape', target: box('opus') })).toBe(true)
    expect(searchHoldsEscape({ key: 'Escape', target: box('') })).toBe(false)
    expect(searchHoldsEscape({ key: 'a', target: box('opus') })).toBe(false)
    expect(searchHoldsEscape({ key: 'Escape', target: null })).toBe(false)
  })
})
