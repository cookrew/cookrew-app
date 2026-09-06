import { describe, expect, it } from 'vitest'
import {
  POLISH_MIN_CHARS,
  buildPolishPrompt,
  buildPolishSystem,
  needsPolish,
  sanitizePolish
} from '../src/shared/sous-polish'

describe('the polish prompt', () => {
  it('puts the rules in the system text and only the transcript in the prompt', () => {
    const system = buildPolishSystem()
    expect(system).toContain('self-corrections')
    expect(system).toContain('Output only the cleaned text')
    const prompt = buildPolishPrompt('  嗯 那个 帮我把测试跑一遍  ')
    expect(prompt).toBe('Transcript:\n嗯 那个 帮我把测试跑一遍\n\nCleaned text:')
    expect(prompt).not.toContain('fillers')
  })
})

describe('sanitizePolish', () => {
  const zh = '嗯那个帮我写一个今日打卡然后发到小红书，不对，发到朋友圈'
  it('accepts a cleaned version, stripping labels, quotes, fences and thinking', () => {
    expect(sanitizePolish('帮我写一个今日打卡，发到朋友圈。', zh)).toBe('帮我写一个今日打卡，发到朋友圈。')
    expect(sanitizePolish('Cleaned text: “帮我写一个今日打卡，发到朋友圈。”', zh)).toBe('帮我写一个今日打卡，发到朋友圈。')
    expect(sanitizePolish('<think>the user changed their mind</think>\n帮我写一个今日打卡，发到朋友圈。', zh)).toBe(
      '帮我写一个今日打卡，发到朋友圈。'
    )
    expect(sanitizePolish('```\n帮我写一个今日打卡，发到朋友圈。\n```', zh)).toBe('帮我写一个今日打卡，发到朋友圈。')
  })
  it('refuses nothing, our own instructions, and a transcript echoed back with its label', () => {
    expect(sanitizePolish('', zh)).toBeNull()
    expect(sanitizePolish('   \n', zh)).toBeNull()
    expect(sanitizePolish('You clean up dictated speech. Remove fillers…', 'um so remove the retry')).toBeNull()
    expect(sanitizePolish(`Transcript:\n${zh}`, zh)).toBeNull()
  })
  it('refuses an answer that grew past the transcript — content the speaker never said', () => {
    const source = 'add a retry around the fetch'
    const padded = `${source} ${'and also '.repeat(20)}`
    expect(sanitizePolish(padded, source)).toBeNull()
  })
  it('refuses an answer that kept only the last clause — a summary is a different request', () => {
    // qwen2.5:3b did exactly this on the sentence above, measured 2026-09-06.
    expect(sanitizePolish('发到朋友圈。', zh)).toBeNull()
  })
  it('refuses a change of script — a translation nobody asked for', () => {
    expect(sanitizePolish('Write a daily check-in and post it to Moments.', zh)).toBeNull()
    expect(sanitizePolish('给 fetch 加一个重试', 'um add a retry around the fetch')).toBeNull()
  })
  it('keeps a cleaned English sentence with code in it', () => {
    const src = 'so um in fetchUser dot ts add a retry around the fetch, like three times'
    expect(sanitizePolish('In fetchUser.ts, add a retry around the fetch — three times.', src)).toBe(
      'In fetchUser.ts, add a retry around the fetch — three times.'
    )
  })
})

describe('needsPolish', () => {
  it('a word or a short command is not worth the round trip', () => {
    expect(needsPolish('run tests')).toBe(false)
    expect(needsPolish('x'.repeat(POLISH_MIN_CHARS))).toBe(true)
    expect(needsPolish('帮我写今日打卡发到小红书')).toBe(true)
  })
})
