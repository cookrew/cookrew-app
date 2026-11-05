// herdr's own agent name follows the card's (owner, 2026-11-02). herdr only
// takes a slug, unique among its live agents, so the card's name is read
// into one — or into none, and herdr's is cleared rather than left stale.
import { describe, expect, it } from 'vitest'
import { herdrAgentName, planAgentNames, uniqueHerdrAgentName, HERDR_AGENT_NAME } from '../src/main/herdr-agent-name'

describe('herdrAgentName', () => {
  it('slugs a card name the way herdr accepts one', () => {
    expect(herdrAgentName('Rename Anyone')).toBe('rename-anyone')
    expect(herdrAgentName('Codex (3)')).toBe('codex-3')
    expect(herdrAgentName('  Billing   Webhook ')).toBe('billing-webhook')
    expect(herdrAgentName('Café Crème')).toBe('cafe-creme')
    expect(herdrAgentName('snake_case_name')).toBe('snake-case-name')
  })

  it('reads a Chinese name as toneless pinyin, one word per run of characters', () => {
    expect(herdrAgentName('顶栏模型切换')).toBe('dinglanmoxingqiehuan')
    expect(herdrAgentName('改名Agent')).toBe('gaiming-agent')
    expect(herdrAgentName('顶栏 Model 切换')).toBe('dinglan-model-qiehuan')
    expect(herdrAgentName('评审 (2)')).toBe('pingshen-2')
  })

  it('falls back to the card id when nothing in the name is readable', () => {
    expect(herdrAgentName('🦊✨', '623a1a96-5832-42a4')).toBe('card-623a1a96')
    expect(herdrAgentName('—', 'ABC-def')).toBe('card-abcdef')
    expect(herdrAgentName('   ')).toBeNull()
    expect(herdrAgentName('—')).toBeNull()
  })

  it('starts with a letter, as herdr requires', () => {
    expect(herdrAgentName('3D Board')).toBe('agent-3d-board')
    expect(herdrAgentName('42')).toBe('agent-42')
  })

  it('never runs past herdr\'s 32 characters, and never ends on a dash', () => {
    const name = herdrAgentName('A very long card name that keeps on going and going')
    expect(name).not.toBeNull()
    expect(name!.length).toBeLessThanOrEqual(32)
    expect(name).toMatch(HERDR_AGENT_NAME)
    expect(name!.endsWith('-')).toBe(false)
  })

  it('always answers a name herdr would accept', () => {
    for (const raw of ['Finch', 'Claude Code (8)', '9lives', 'x', 'Z'.repeat(80), 'a-b_c', 'Ölçek Ünite', '一二三四五六七八九十一二三四五六七八九十', '3号机']) {
      const name = herdrAgentName(raw)
      if (name !== null) expect(name).toMatch(HERDR_AGENT_NAME)
    }
  })
})

describe('uniqueHerdrAgentName', () => {
  it('keeps the name when no other live agent wears it', () => {
    expect(uniqueHerdrAgentName('reviewer', new Set(['finch']))).toBe('reviewer')
  })

  it('suffixes past every live agent that wears it', () => {
    expect(uniqueHerdrAgentName('reviewer', new Set(['reviewer', 'reviewer-2']))).toBe('reviewer-3')
  })

  it('stays within 32 characters with the suffix', () => {
    const base = 'a'.repeat(32)
    const name = uniqueHerdrAgentName(base, new Set([base]))
    expect(name).toBe(`${'a'.repeat(30)}-2`)
    expect(name).toMatch(HERDR_AGENT_NAME)
  })
})

describe('planAgentNames', () => {
  const ours = (pane: string, title: string, name?: string) => ({
    pane_id: pane, title, ...(name ? { name } : {}), tokens: { cookrew_terminal: `t-${pane}` }
  })

  it('keeps a long name that won a suffix, cut the way uniqueHerdrAgentName cuts it', () => {
    const title = '手机 inputbox 优化 去掉没用 搜索按钮'
    const base = herdrAgentName(title)!
    expect(base.length).toBeGreaterThan(30)
    const won = uniqueHerdrAgentName(base, new Set([base]))
    const plan = planAgentNames([ours('p1', title, base), ours('p2', title, won)], new Map())
    expect(plan.rename).toEqual([])
    expect(plan.keep.map((k) => k.name)).toEqual([base, won])
  })
})
