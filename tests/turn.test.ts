import { describe, expect, it } from 'vitest'
import {
  cleanTurnLines,
  detectAgentActivity,
  detectAttention,
  detectLiveWork,
  extractPromptEcho,
  feedPromptBuffer,
  isLiveStatus,
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

  // Shift+Enter (ESC+CR, the TUI insert-newline binding) must NEVER count as
  // a submit — one real Enter = one checkpoint (checkpoint 1:1 spec).
  it('treats Shift+Enter as a literal newline, not a submit', () => {
    const fed = feedPromptBuffer('', 'line1\x1b\r')
    expect(fed.submitted).toEqual([])
    expect(fed.buffer).toBe('line1\n')
  })

  it('submits a multiline composition as ONE prompt on the real Enter', () => {
    const fed = feedPromptBuffer('', 'line1\x1b\rline2\r')
    expect(fed.submitted).toEqual(['line1\nline2'])
    expect(fed.buffer).toBe('')
  })

  it('handles Shift+Enter split across input chunks (held trailing ESC)', () => {
    const a = feedPromptBuffer('', 'line1\x1b')
    expect(a.submitted).toEqual([])
    const b = feedPromptBuffer(a.buffer, '\rline2\r', a.inPaste, a.held)
    expect(b.submitted).toEqual(['line1\nline2'])
    expect(b.buffer).toBe('')
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

  it('never submits on carriage returns inside a bracketed paste', () => {
    const fed = feedPromptBuffer('', '\x1b[200~step one\rstep two\r\nstep three\x1b[201~')
    expect(fed.submitted).toEqual([])
    expect(fed.buffer).toBe('step one\nstep two\nstep three')
    expect(fed.inPaste).toBe(false)
  })

  it('keeps the paste open across chunks until the close marker arrives', () => {
    const a = feedPromptBuffer('', '\x1b[200~')
    expect(a.inPaste).toBe(true)
    const b = feedPromptBuffer(a.buffer, 'do the thing\r', a.inPaste)
    expect(b.submitted).toEqual([])
    expect(b.buffer).toBe('do the thing\n')
    expect(b.inPaste).toBe(true)
    const c = feedPromptBuffer(b.buffer, 'now\x1b[201~', b.inPaste)
    expect(c.inPaste).toBe(false)
    expect(c.buffer).toBe('do the thing\nnow')
    const d = feedPromptBuffer(c.buffer, '\r', c.inPaste)
    expect(d.submitted).toEqual(['do the thing\nnow'])
    expect(d.buffer).toBe('')
  })

  it('submits typed Enter after a paste with the pasted text included', () => {
    const pasted = feedPromptBuffer('', '\x1b[200~fix src/a.ts\x1b[201~ please')
    expect(pasted.submitted).toEqual([])
    const fed = feedPromptBuffer(pasted.buffer, '\r', pasted.inPaste)
    expect(fed.submitted).toEqual(['fix src/a.ts please'])
  })

  it('still handles typed Enter outside any paste', () => {
    const fed = feedPromptBuffer('fix the bug', '\r', false)
    expect(fed.submitted).toEqual(['fix the bug'])
    expect(fed.inPaste).toBe(false)
  })
})

describe('detectAgentActivity', () => {
  it('flags live spinner status lines', () => {
    expect(detectAgentActivity('✻ Cerebrating… (esc to interrupt · 4s · ↓ 1.2k tokens)')).toBe(true)
  })

  it('flags transcript tool/message entries', () => {
    expect(detectAgentActivity('⏺ Bash(npm test)')).toBe(true)
  })

  it('sees through interleaved escape sequences', () => {
    expect(detectAgentActivity('\x1b[2K\x1b[G✻ Baking… (esc to interrupt)')).toBe(true)
  })

  it('ignores plain output and typed-echo redraws', () => {
    expect(detectAgentActivity('$ ls\nfile-a  file-b')).toBe(false)
    expect(detectAgentActivity('│ > fix the bug   │')).toBe(false)
    expect(detectAgentActivity('')).toBe(false)
  })
})

describe('isLiveStatus', () => {
  it('recognises in-flight spinner bodies', () => {
    expect(isLiveStatus('Honking… (23m 20s · ↓ 24.5k tokens)')).toBe(true)
    expect(isLiveStatus('Cerebrating… (esc to interrupt · 34s)')).toBe(true)
    expect(isLiveStatus('Baking…')).toBe(true)
  })

  it('rejects completed-turn status bodies', () => {
    expect(isLiveStatus('Brewed for 4m 15s')).toBe(false)
    expect(isLiveStatus('Baked for 1m 6s')).toBe(false)
    // Even when a completed line carries a token counter, the past-tense
    // "<verb>ed for <time>" prefix marks it as finished.
    expect(isLiveStatus('Baked for 1m 6s · ↓ 2.1k tokens')).toBe(false)
  })

  it('rejects plain non-status text', () => {
    expect(isLiveStatus('all tests pass')).toBe(false)
  })
})

describe('extractPromptEcho', () => {
  it('returns the most recent prompt echo line', () => {
    const lines = ['> old prompt', '⏺ old reply', '> make it the app icon too', '⏺ working…']
    expect(extractPromptEcho(lines)).toBe('make it the app icon too')
  })

  it('ignores numbered menu rows and empty input boxes', () => {
    expect(extractPromptEcho(['❯ 1. Yes', '  2. No'])).toBe(null)
    expect(extractPromptEcho(['❯', '> '])).toBe(null)
  })

  it('returns null when no echo is present', () => {
    expect(extractPromptEcho(['⏺ some reply', '✻ Brewed for 4m 15s'])).toBe(null)
    expect(extractPromptEcho([])).toBe(null)
  })
})

describe('detectLiveWork', () => {
  it('flags the mid-turn "esc to interrupt" spinner, even across escapes', () => {
    expect(detectLiveWork('✻ Cerebrating… (esc to interrupt · 34s · ↓ 2.1k tokens)')).toBe(true)
    expect(detectLiveWork('\x1b[2K\x1b[38;5;205m✻ Baking… (esc to interrupt)\x1b[0m')).toBe(true)
  })

  it('flags current-style live spinners without "esc to interrupt"', () => {
    expect(detectLiveWork('✶ Honking… (23m 20s · ↓ 24.5k tokens)')).toBe(true)
  })

  it('does not flag finished-turn status or plain transcript redraws', () => {
    expect(detectLiveWork('✳ Baked for 1m 6s')).toBe(false)
    expect(detectLiveWork('✻ Brewed for 4m 15s')).toBe(false)
    expect(detectLiveWork('⏺ I finished the refactor earlier.')).toBe(false)
    expect(detectLiveWork('$ ls')).toBe(false)
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

describe('feedPromptBuffer split paste markers (DEFECT 2a)', () => {
  it('holds back a chunk-split open marker — CR in pasted text never submits', () => {
    const a = feedPromptBuffer('', '\x1b[200')
    expect(a.submitted).toEqual([])
    expect(a.buffer).toBe('')
    expect(a.held).toBe('\x1b[200')

    const b = feedPromptBuffer(a.buffer, '~step one\rstep two', a.inPaste, a.held)
    expect(b.inPaste).toBe(true)
    expect(b.submitted).toEqual([])
    expect(b.buffer).toBe('step one\nstep two')

    const c = feedPromptBuffer(b.buffer, '\x1b[201~', b.inPaste, b.held)
    expect(c.inPaste).toBe(false)
    expect(c.buffer).toBe('step one\nstep two')
    expect(c.held).toBe('')
  })

  it('holds back a chunk-split close marker without leaking it into the buffer', () => {
    const a = feedPromptBuffer('', '\x1b[200~pasted\x1b[201')
    expect(a.inPaste).toBe(true)
    expect(a.buffer).toBe('pasted')
    expect(a.held).toBe('\x1b[201')

    const b = feedPromptBuffer(a.buffer, '~', a.inPaste, a.held)
    expect(b.inPaste).toBe(false)
    expect(b.buffer).toBe('pasted')
  })

  it('keeps single-chunk behavior identical when nothing is split', () => {
    const fed = feedPromptBuffer('', '\x1b[200~hello\x1b[201~world\r')
    expect(fed.buffer).toBe('')
    expect(fed.submitted).toEqual(['helloworld'])
    expect(fed.held).toBe('')
  })
})
