import { describe, expect, it } from 'vitest'
import { closePrompt } from '../src/renderer/src/confirm-close'
import type { BrowserNodeData, NoteNodeData, TerminalNodeData } from '../src/shared/model'

const at = { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }

const terminal = (over: Partial<TerminalNodeData> = {}): TerminalNodeData => ({
  kind: 'terminal',
  id: 't1',
  name: 'Fresco',
  preset: 'Claude Code',
  command: 'claude',
  cwd: '/w',
  orch: false,
  role: null,
  ...at,
  ...over,
})

const note = (over: Partial<NoteNodeData> = {}): NoteNodeData => ({
  kind: 'note',
  id: 'n1',
  name: 'the-plan',
  customName: null,
  content: 'the plan',
  locked: false,
  ...at,
  ...over,
})

const browser = (over: Partial<BrowserNodeData> = {}): BrowserNodeData => ({
  kind: 'browser',
  id: 'b1',
  name: 'Browser',
  url: 'https://example.com',
  ...at,
  ...over,
})

describe('closePrompt — a confirm that says what is lost, not just "are you sure"', () => {
  it('names the agent and that its session ends', () => {
    const p = closePrompt(terminal())
    expect(p.title).toBe('Close this agent?')
    expect(p.subject).toBe('Fresco · Claude Code')
    expect(p.confirmLabel).toBe('Close agent')
  })

  it('tells the truth about recovery — an agent can come back', () => {
    // The roster's RECOVER exists, so claiming this is permanent would be a
    // lie that makes people keep dead agents around.
    expect(closePrompt(terminal()).consequence).toMatch(/recover/i)
  })

  it('warns harder while the agent is mid-turn', () => {
    const p = closePrompt(terminal(), { phase: 'thinking' })
    expect(p.consequence).toMatch(/working right now/i)
    expect(p.danger).toBe(true)
  })

  it('warns while the agent is waiting on you — that turn is unanswered', () => {
    expect(closePrompt(terminal(), { phase: 'waiting' }).danger).toBe(true)
  })

  it('an idle agent is not flagged as dangerous', () => {
    expect(closePrompt(terminal(), { phase: 'idle' }).danger).toBe(false)
  })

  it('an orchestrator says so, because the crew is wired to it', () => {
    expect(closePrompt(terminal({ orch: true })).subject).toMatch(/orch/i)
  })

  it('a note is the one that is genuinely unrecoverable', () => {
    const p = closePrompt(note())
    expect(p.title).toBe('Delete this note?')
    expect(p.consequence).toMatch(/not kept anywhere else/i)
    expect(p.danger).toBe(true)
  })

  it('an empty note is not worth a scary prompt', () => {
    const p = closePrompt(note({ content: '   ' }))
    expect(p.danger).toBe(false)
    expect(p.subject).toBe('Empty note')
  })

  it('a note is summarised by its first line, so you know which one', () => {
    expect(closePrompt(note({ content: 'Deploy checklist\nstep one' })).subject).toBe(
      'Deploy checklist'
    )
  })

  it('counts the tabs a browser takes with it', () => {
    const p = closePrompt(
      browser({
        tabs: [
          { id: '1', url: 'a', title: '' },
          { id: '2', url: 'b', title: '' },
          { id: '3', url: 'c', title: '' },
        ],
      })
    )
    expect(p.title).toBe('Close this browser?')
    expect(p.consequence).toMatch(/3 tabs/)
  })

  it('says "tab" not "tabs" for one', () => {
    expect(closePrompt(browser()).consequence).toMatch(/\b1 tab\b/)
  })

  it('a browser is never flagged dangerous — it is the cheap one to reopen', () => {
    expect(closePrompt(browser()).danger).toBe(false)
  })
})

describe('closing a placed orch card is a spending decision', () => {
  /**
   * A card you paid for is the one case the roster CANNOT recover: the
   * session lives at the author's app, and re-importing admits a new one.
   * Before this, the ordinary terminal prompt promised "you can recover the
   * agent from Agents" — an offer nothing here can keep.
   */
  const served = (paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }): TerminalNodeData =>
    terminal({
      name: 'COOKREW Alpha',
      preset: 'Remote',
      orch: true,
      servedSession: {
        origin: 'http://127.0.0.1:8639',
        slug: 'cookrew-alpha',
        openedAt: 1_700_000_000_000,
        ...(paid ? { paid } : {})
      }
    })

  it('quotes what was actually paid, and warns that starting again costs again', () => {
    const prompt = closePrompt(served({ price: '2.50', asset: 'USD', rail: 'stripe' }))
    expect(prompt.title).toBe('End this session?')
    expect(prompt.subject).toBe('COOKREW Alpha')
    expect(prompt.consequence).toContain('2.50 USD')
    expect(prompt.consequence).toContain('new session at the same price')
    // Whose machine the work stayed on — the caller keeps none of it.
    expect(prompt.consequence).toContain("@cookrew-alpha's machine")
    expect(prompt.confirmLabel).toBe('End session')
    expect(prompt.danger).toBe(true)
  })

  it('never promises a recovery that does not exist for a served session', () => {
    for (const node of [served({ price: '1', asset: 'USDC', rail: 'x402' }), served()]) {
      expect(closePrompt(node).consequence).not.toMatch(/recover/i)
    }
  })

  it('a free session is not danger, and says why re-opening may not work', () => {
    const prompt = closePrompt(served())
    expect(prompt.danger).toBe(false)
    expect(prompt.consequence).toContain('limited number')
    // No price is invented for a door that charged nothing.
    expect(prompt.consequence).not.toMatch(/\d\.\d\d/)
  })

  it('an ordinary agent card is untouched by any of this', () => {
    const prompt = closePrompt(terminal())
    expect(prompt.title).toBe('Close this agent?')
    expect(prompt.consequence).toContain('recover')
  })
})
