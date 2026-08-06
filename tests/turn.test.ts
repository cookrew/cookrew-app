import { describe, expect, it } from 'vitest'
import {
  MAX_TURN_PAGE,
  TURN_TAIL_WINDOW,
  latestTailLines,
  pageTurns,
  cleanTurnLines,
  detectAgentActivity,
  detectAttention,
  detectLiveWork,
  extractPromptEcho,
  feedPromptBuffer,
  isCommandPrompt,
  isLiveStatus,
  parseAgentGlance,
  tailLines,
  appendTurnRecord,
  type TurnRecord
} from '../src/shared/turn'

describe('isCommandPrompt', () => {
  it('flags raw typed slash commands (UI actions, not conversation)', () => {
    expect(isCommandPrompt('/rewind')).toBe(true)
    expect(isCommandPrompt('/clear')).toBe(true)
    expect(isCommandPrompt('/model opus')).toBe(true)
    expect(isCommandPrompt('  /compact  ')).toBe(true)
  })

  it('does NOT flag paths or ordinary prompts that merely contain a slash', () => {
    expect(isCommandPrompt('/tmp/x.ts fix the bug')).toBe(false) // 2nd slash
    expect(isCommandPrompt('/Users/foo')).toBe(false) // uppercase root
    expect(isCommandPrompt('fix the bug')).toBe(false)
    expect(isCommandPrompt('run /review later')).toBe(false) // slash mid-line
  })
})

describe('parseAgentGlance — Codex glyphs', () => {
  it('reads the • reply and ignores a trailing › suggestion row', () => {
    // Codex echoes with › and replies with •; the last › is a UI suggestion.
    const codex = [
      '› Now reply with exactly: CODEX-QA-BRAVO',
      '',
      '• CODEX-QA-BRAVO',
      '',
      '› Run /review on my current changes'
    ].join('\n')
    expect(parseAgentGlance(codex).message).toBe('CODEX-QA-BRAVO')
  })

  it('does not treat an indented Claude bullet list as a Codex reply glyph', () => {
    const claude = ['⏺ Here are the options:', '  • first', '  • second'].join('\n')
    expect(parseAgentGlance(claude).message).toBe('Here are the options:\n• first\n• second')
  })
})

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

  /**
   * status-left is '#[bold] cookrew · #S #[nobold] ', but status-left-length
   * defaults to 10 — exactly the width of ' cookrew ·'. tmux therefore drops
   * the session name AND the separating space, and the window list runs
   * straight on: ' cookrew ·1:node*'. That is the only form that has ever
   * reached a card; the untruncated form above never renders.
   */
  it('drops the tmux status bar as tmux actually renders it (truncated at 10)', () => {
    expect(cleanTurnLines('Here is the plan.\n cookrew ·1:node*')).toEqual(['Here is the plan.'])
  })

  it('drops it for every harness, not just node', () => {
    for (const bar of [' cookrew ·1:claude.exe*', ' cookrew ·1:node*', 'cookrew ·2:zsh-']) {
      expect(cleanTurnLines(`answer\n${bar}`)).toEqual(['answer'])
    }
  })

  it('does not eat a real line that merely mentions cookrew', () => {
    expect(cleanTurnLines('run cookrew ask to send a prompt')).toEqual([
      'run cookrew ask to send a prompt'
    ])
  })

  /**
   * The pi/ifunk TUI closes with two status rows below its input box: a
   * cwd + git-branch row and a token/context meter. They are the LAST lines
   * on screen, so a card falling back to the screen tail showed the meter
   * instead of the agent's last words. Captured verbatim from a live pane.
   */
  it('drops the pi footer so the tail is the agent, not its status bar', () => {
    const raw = [
      ' Navigated to selected point',
      '',
      '─────────────────────────────',
      '',
      '─────────────────────────────',
      '~/workspace/cookrew-dev (fix/card-single-view)',
      '↑599k ↓116k R21M ?/128k (auto)                          (ifunk) k3'
    ].join('\n')
    // The card's fallback drops blanks then takes the last line, so assert on
    // exactly that — cleanTurnLines collapses blank RUNS but does not trim.
    const kept = cleanTurnLines(raw).filter((l) => l.trim().length > 0)
    expect(kept[kept.length - 1]).toBe(' Navigated to selected point')
  })

  it('drops the meter however full the context is', () => {
    for (const meter of [
      '↑599k ↓116k R21M ?/128k (auto)     (ifunk) k3',
      '0.0%/128k (auto)                   (ifunk) k3',
      '↑106k ↓54k R5.0M 75.8%/128k (auto) (ifunk) k3'
    ]) {
      expect(cleanTurnLines(`done\n${meter}`)).toEqual(['done'])
    }
  })

  it('drops the cwd row when it sits directly above the meter', () => {
    const meter = '↑1k ↓1k ?/128k (auto)   (ifunk) k3'
    expect(cleanTurnLines(`done\n~/workspace/cookrew-dev (main)\n${meter}`)).toEqual(['done'])
    // Outside a git repo the row is a bare path with no branch.
    expect(cleanTurnLines(`done\n/private/tmp\n${meter}`)).toEqual(['done'])
  })

  /**
   * Adjacency IS the signal. A bare path on its own is ordinary output — a
   * glob hit, a pwd, a file reference — and must survive.
   */
  it('keeps a path line that is not the meter’s cwd row', () => {
    expect(cleanTurnLines('done\n/private/tmp')).toEqual(['done', '/private/tmp'])
    expect(cleanTurnLines('/Users/drej/workspace/cookrew-dev\nnext line')).toEqual([
      '/Users/drej/workspace/cookrew-dev',
      'next line'
    ])
  })

  // Over-cleaning guards. Tool output is full of "<path> (<n> lines)" and
  // prose is full of parentheses; none of it may be mistaken for chrome.
  it('does not eat tool output that looks like a path in parentheses', () => {
    for (const real of [
      'Read src/renderer/src/remote-api.ts (237 lines)',
      '  src/main/index.ts (1312 lines)',
      'Referenced file tests/board-merge.test.ts',
      '- Final state: dev at a6c27e6+ — 923 passed / 3 skipped (874 baseline)',
      'the model selection is (auto) by default',
      'we trimmed it to 128k (roughly)',
      '/Users/drej/workspace/cookrew-dev'
    ]) {
      expect(cleanTurnLines(real)).toEqual([real])
    }
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

describe('pageTurns (context-view v2 paged windows)', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    index: i + 1,
    prompt: `prompt ${i + 1}`,
    reply: `reply ${i + 1}`,
    startedAt: i,
    endedAt: i + 1
  }))

  it('defaults to the TAIL window (initial mount load)', () => {
    const page = pageTurns(history, { limit: 3 })
    expect(page.total).toBe(10)
    expect(page.offset).toBe(7)
    expect(page.turns.map((t) => t.index)).toEqual([8, 9, 10])
  })

  it('serves an offset window in oldest-first block order', () => {
    const page = pageTurns(history, { offset: 2, limit: 3 })
    expect(page.offset).toBe(2)
    expect(page.turns.map((t) => t.index)).toEqual([3, 4, 5])
  })

  it('clamps windows that run past either end', () => {
    expect(pageTurns(history, { offset: 8, limit: 5 }).turns.map((t) => t.index)).toEqual([9, 10])
    const head = pageTurns(history, { offset: -2, limit: 3 })
    expect(head.offset).toBe(0)
    expect(head.turns.map((t) => t.index)).toEqual([1, 2, 3])
  })

  it('centers on aroundIndex for checkpoint-click fetches', () => {
    const page = pageTurns(history, { aroundIndex: 5, limit: 3 })
    expect(page.turns.map((t) => t.index)).toEqual([4, 5, 6])
    expect(page.offset).toBe(3) // blockIndex of record index 4
  })

  it('falls back to the tail when aroundIndex is unknown', () => {
    const page = pageTurns(history, { aroundIndex: 99, limit: 2 })
    expect(page.turns.map((t) => t.index)).toEqual([9, 10])
  })

  it('handles empty history and caps the limit', () => {
    expect(pageTurns([], { limit: 5 })).toEqual({ turns: [], total: 0, offset: 0 })
    const capped = pageTurns(history, { limit: 5000 })
    expect(capped.turns).toHaveLength(10)
  })
})

describe('latestTailLines (live-tail boundary, unified-scroll item 1)', () => {
  it('counts lines from the bottom through the last COMPLETED status line', () => {
    const buffer = [
      '⏺ older reply',
      '✻ Brewed for 4m 15s', // older completion
      '⏺ latest reply body',
      '✻ Worked for 12s', // ← the boundary
      '',
      '╭──────╮',
      '│ >    │',
      '╰──────╯'
    ].join('\n')
    // 5 lines: completion line + everything below it.
    expect(latestTailLines(buffer)).toBe(5)
  })

  it('ignores LIVE spinner lines (esc to interrupt) as boundaries', () => {
    const buffer = ['⏺ reply', '✻ Cerebrating… (esc to interrupt · 3s)'].join('\n')
    expect(latestTailLines(buffer)).toBeNull()
  })

  it('returns null when no completion line exists (show everything)', () => {
    expect(latestTailLines('plain shell output\nmore output')).toBeNull()
    expect(latestTailLines('')).toBeNull()
  })
})

/**
 * History is uncapped now; page size is a separate, still-bounded concern
 * because pageTurns returns FULL bodies.
 */
describe('uncapped history vs bounded pages', () => {
  it('keeps every turn, so the count stays truthful', () => {
    let history: TurnRecord[] = []
    for (let i = 0; i < 1200; i++) history = appendTurnRecord(history, {
      prompt: 'p',
      reply: 'r',
      startedAt: i,
      endedAt: i + 1
    })
    expect(history).toHaveLength(1200)
    expect(history[history.length - 1].index).toBe(1200)
  })

  it('holds a working window smaller than the history', () => {
    expect(TURN_TAIL_WINDOW).toBeGreaterThan(MAX_TURN_PAGE - 1)
  })

  it('clamps a page even when the history is far larger', () => {
    const history = Array.from({ length: 1200 }, (_, i) => ({
      index: i + 1,
      prompt: 'p',
      reply: 'r',
      startedAt: i,
      endedAt: i + 1
    })) as TurnRecord[]
    expect(pageTurns(history, { limit: 1200 }).turns).toHaveLength(MAX_TURN_PAGE)
  })

  it('still reports the true total so the virtualizer sizes correctly', () => {
    const history = Array.from({ length: 300 }, (_, i) => ({
      index: i + 1,
      prompt: 'p',
      reply: 'r',
      startedAt: i,
      endedAt: i + 1
    })) as TurnRecord[]
    expect(pageTurns(history, { limit: 20 }).total).toBe(300)
  })
})
