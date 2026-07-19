import { describe, expect, it } from 'vitest'
import {
  cleanTurnLines,
  detectAttention,
  feedPromptBuffer,
  parseAgentGlance,
  tailLines
} from '../src/shared/turn'

describe('feedPromptBuffer', () => {
  it('accumulates typed characters', () => {
    const fed = feedPromptBuffer('', 'fix the bug')
    expect(fed.buffer).toBe('fix the bug')
    expect(fed.submitted).toEqual([])
  })

  it('submits on Enter and resets the buffer', () => {
    const fed = feedPromptBuffer('fix the bug', '\r')
    expect(fed.submitted).toEqual(['fix the bug'])
    expect(fed.buffer).toBe('')
  })

  it('handles backspace', () => {
    const fed = feedPromptBuffer('abc', '\x7f\x7fd')
    expect(fed.buffer).toBe('ad')
  })

  it('clears on ctrl-c and ctrl-u', () => {
    expect(feedPromptBuffer('abc', '\x03x').buffer).toBe('x')
    expect(feedPromptBuffer('abc', '\x15y').buffer).toBe('y')
  })

  it('strips cursor-key and bracketed-paste escape sequences', () => {
    const fed = feedPromptBuffer('', '\x1b[200~pasted text\x1b[201~\x1b[A\x1b[3~')
    expect(fed.buffer).toBe('pasted text')
  })

  it('strips SGR mouse reports and SS3 sequences', () => {
    const fed = feedPromptBuffer(
      '',
      '\x1b[<0;39;37M\x1b[<32;39;37M\x1b[<0;39;37mfix it\x1bOA\x1b[I'
    )
    expect(fed.buffer).toBe('fix it')
  })

  it('splits multiple submissions in one chunk', () => {
    const fed = feedPromptBuffer('', 'one\rtwo\r')
    expect(fed.submitted).toEqual(['one', 'two'])
  })

  it('strips OSC color-query responses injected under tmux', () => {
    // A GUI xterm answering tmux OSC 10/11 queries injects the response into
    // the input stream mid-prompt; it must not pollute the captured prompt.
    const fed = feedPromptBuffer(
      '',
      'merge \x1b]10;rgb:e9e9/b9b9/4949\x1b\\\x1b]11;rgb:1414/1111/0a0a\x1b\\the products'
    )
    expect(fed.buffer).toBe('merge the products')
  })

  it('strips bare OSC color remnants (leading ESC split off)', () => {
    const fed = feedPromptBuffer('', 'name]10;rgb:e9e9/b9b9/4949\\ here')
    expect(fed.buffer).toBe('name here')
  })
})

describe('cleanTurnLines', () => {
  it('drops box-drawing chrome and status bars', () => {
    const raw = [
      '╭──────────────╮',
      '│ >            │',
      '╰──────────────╯',
      '✻ Thinking about the fix',
      '  esc to interrupt · 3s',
      'Here is the answer.'
    ].join('\n')
    expect(cleanTurnLines(raw)).toEqual(['✻ Thinking about the fix', 'Here is the answer.'])
  })

  it('collapses blank runs', () => {
    expect(cleanTurnLines('a\n\n\n\nb')).toEqual(['a', '', 'b'])
  })

  it('drops the tmux status bar line and claude bypass hint', () => {
    const raw = [
      'Here is the plan.',
      '  ▶▶ bypass permissions on (shift+tab to cycle) · ← for agents',
      ' cookrew · cookrew_579510a4  0:claude.exe*'
    ].join('\n')
    expect(cleanTurnLines(raw)).toEqual(['Here is the plan.'])
  })

  it('strips OSC color noise from turn text', () => {
    expect(cleanTurnLines('answer \x1b]11;rgb:1414/1111/0a0a\x1b\\ done')).toEqual(['answer  done'])
  })
})

describe('detectAttention', () => {
  it('flags permission prompts and choice menus', () => {
    expect(detectAttention(['Do you want to make this edit?', '❯ 1. Yes', '  2. No'])).toBe(true)
    expect(detectAttention(['Overwrite file? (y/n)'])).toBe(true)
    expect(detectAttention(['Enter to confirm · Esc to cancel'])).toBe(true)
  })

  it('does not flag normal replies', () => {
    expect(detectAttention(['Done. I fixed the bug in pty.ts.', 'All 22 tests pass.'])).toBe(false)
    expect(detectAttention([])).toBe(false)
  })

  it('only inspects the tail', () => {
    const lines = ['Do you want to proceed?', ...Array.from({ length: 15 }, (_, i) => `line ${i}`)]
    expect(detectAttention(lines)).toBe(false)
  })
})

describe('parseAgentGlance', () => {
  const TRANSCRIPT = [
    '> fix the bug',
    '',
    '⏺ Bash(npm test)',
    '  ⎿ 22 passed',
    '',
    '⏺ I found the issue — the listener leaks on remount.',
    '  Patching the effect cleanup now.',
    '',
    '✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)'
  ].join('\n')

  it('extracts status, recent tools and latest message', () => {
    const glance = parseAgentGlance(TRANSCRIPT)
    expect(glance.status).toBe('Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')
    expect(glance.tools).toEqual(['Bash(npm test)'])
    expect(glance.message).toBe(
      'I found the issue — the listener leaks on remount.\nPatching the effect cleanup now.'
    )
  })

  it('keeps the last three tools in order and the latest message', () => {
    const glance = parseAgentGlance(
      `${TRANSCRIPT}\n⏺ Read(src/pty.ts)\n⏺ Grep(onExit)\n⏺ Edit(src/pty.ts)\n⏺ Done — all tests pass.`
    )
    expect(glance.tools).toEqual(['Read(src/pty.ts)', 'Grep(onExit)', 'Edit(src/pty.ts)'])
    expect(glance.message).toBe('Done — all tests pass.')
  })

  it('recognises real Claude Code completion status lines', () => {
    const glance = parseAgentGlance('⏺ 查了一圈，仓库还没有提交。\n\n✳ Baked for 1m 6s')
    expect(glance.status).toBe('Baked for 1m 6s')
    expect(glance.message).toBe('查了一圈，仓库还没有提交。')
  })

  it('returns nulls on plain shell output', () => {
    const glance = parseAgentGlance('$ ls\nfile-a  file-b')
    expect(glance).toEqual({ status: null, tools: [], message: null })
  })
})

describe('tailLines', () => {
  it('returns the last n lines without leading blanks', () => {
    expect(tailLines(['a', 'b', '', 'c', 'd'], 3)).toEqual(['c', 'd'])
    expect(tailLines(['a', 'b'], 5)).toEqual(['a', 'b'])
  })
})
