// THE group/auto LOCAL TIER, PRINTED NEVER RUN (route program, E2E round).
// The picker runs on a /v1/models body recorded off magpie 0.1.1182
// (tests/fixtures/magpie/models-local.json): the Ollama models that take a
// reasoning ask are members, the ones that refuse are named with the reason,
// the one line printed carries routing=smart and stays=turn, and the script
// has no way to run anything.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain ESM script, typed here by its test
import { autoGroupPlan, classify, render } from '../scripts/route-auto-group.mjs'

const catalog = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'magpie', 'models-local.json'), 'utf8')) as { data: { id: string }[] }

describe('the auto group plan', () => {
  it('members are the Ollama thinkers; qwen2.5 is left out with the 400 it answered', () => {
    const plan = autoGroupPlan(catalog) as { members: string[]; excluded: { id: string; why: string }[]; exists: boolean; commands: string[] }
    // In the catalog's own order, so the line reads as the gateway lists them.
    expect(plan.members).toEqual(['ollama/qwen3:1.7b', 'ollama/qwen3:4b'])
    expect(plan.excluded.map((e) => e.id)).toEqual(['ollama/qwen2.5:3b', 'ollama/qwen2.5:1.5b'])
    expect(plan.excluded[0].why).toContain('does not support thinking')
    expect(plan.exists).toBe(false)
    expect(plan.commands).toEqual(['magpie group add auto models=ollama/qwen3:1.7b,ollama/qwen3:4b routing=smart stays=turn'])
  })

  it('says set, not add, when group/auto already exists; prints nothing to add without a thinker', () => {
    const withAuto = { data: [...catalog.data, { id: 'group/auto', owned_by: 'ollama', magpie_label: 'auto · routing group' }] }
    expect((autoGroupPlan(withAuto) as { commands: string[] }).commands[0]).toMatch(/^magpie group set auto models=.* routing=smart stays=turn$/)
    const none = autoGroupPlan({ data: [{ id: 'ollama/qwen2.5:3b' }, { id: 'claude/claude-opus-5-5' }] }) as { commands: string[] }
    expect(none.commands).toEqual([])
    expect(render(none)).toContain('nothing to add')
  })

  it('the printed text is a commented plan and the one line, with stays=turn, never a run', () => {
    const text = render(autoGroupPlan(catalog)) as string
    expect(text).toContain('#   + ollama/qwen3:4b')
    expect(text).toContain('#   - ollama/qwen2.5:3b: refuses')
    expect(text).toContain('printed, not run')
    expect(text.trim().endsWith('routing=smart stays=turn')).toBe(true)
    expect(text).not.toContain('stays=session')
    // Nothing in the script can execute a line: no child process, no shell.
    const source = readFileSync(path.join(__dirname, '..', 'scripts', 'route-auto-group.mjs'), 'utf8')
    expect(source).not.toMatch(/child_process|execFile|spawn\(|exec\(/)
  })

  it('classifies by family and says why', () => {
    expect(classify('ollama/qwen3:1.7b')).toEqual({ ok: true, why: 'takes a reasoning ask' })
    expect((classify('ollama/qwen2.5:1.5b') as { ok: boolean }).ok).toBe(false)
    expect((classify('ollama/llama3.1:8b') as { ok: boolean }).ok).toBe(false)
    expect((classify('ollama/mystery:7b') as { why: string }).why).toContain('unknown family')
  })
})
