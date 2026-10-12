// EXPOSURE (HP round, lane hp-decide): the tier a sentence carries and the one
// positive line the brief gets at 2 and above. The five sentences from the
// product audit, in both languages the owner speaks.
import { describe, expect, it } from 'vitest'
import { boundaries, exposure } from '../src/shared/sous-exposure'

describe('exposure — the five audit sentences', () => {
  it('reading is 0, editing is 1, leaving the tree is 2, a secret is 3', () => {
    expect(exposure('read the README and explain the install section')).toMatchObject({ score: 0 })
    expect(exposure('fix the typo in the install section')).toMatchObject({ score: 1, why: 'fix' })
    expect(exposure('push the branch once the tests pass')).toMatchObject({ score: 2, why: 'push' })
    expect(exposure('删掉 v1 的路由和它们的测试')).toMatchObject({ score: 2, why: '删掉' })
    expect(exposure('把 API key 写进 .env 然后发版')).toMatchObject({ score: 3 })
  })

  it('the highest tier present wins, in either language', () => {
    expect(exposure('write a haiku about cables').score).toBe(1)
    expect(exposure('merge the PR and deploy').score).toBe(2)
    expect(exposure('rotate the password for the staging account').score).toBe(3)
    expect(exposure('给 Forge 的账号改密码').score).toBe(3)
    expect(exposure('a haiku').score).toBe(0)
    expect(exposure('a haiku').why).toBeNull()
  })
})

describe('boundaries — one positive line at 2 and above, none below', () => {
  it('names what the card may do and under what condition', () => {
    expect(boundaries(2, 'push the branch')).toBe('push only after the check passes')
    expect(boundaries(2, '测试通过后推送')).toBe('测试通过后才推送')
    expect(boundaries(2, 'delete the v1 routes')).toBe('delete only what this sentence names and keep everything else')
    expect(boundaries(2, 'pay the invoice')).toMatch(/^spend only/)
    expect(boundaries(3, 'use the stripe key')).toMatch(/sealed slot/)
    expect(boundaries(3, '用 stripe 的密钥')).toMatch(/封好的槽位/)
  })

  it('a prohibition never appears; below 2 there is no line', () => {
    for (const s of ['push it', 'delete it', 'deploy', 'pay', 'change the config']) {
      const line = boundaries(2, s) ?? ''
      expect(line).not.toMatch(/\bnever\b|\bdo not\b|\bdon't\b/)
      expect(line.length).toBeGreaterThan(0)
    }
    expect(boundaries(1, 'fix the typo')).toBeNull()
    expect(boundaries(0, 'read it')).toBeNull()
  })
})
