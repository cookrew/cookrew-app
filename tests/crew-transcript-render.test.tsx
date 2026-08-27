import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServedCrewLive, servedGateReply } from '../src/renderer/src/ServedCrewLive'
import { TurnPagerBar, type TurnPaging } from '../src/renderer/src/nodes/TurnPager'
import type { TerminalActivity } from '../src/shared/turn'
import { MKT_GATE } from '../src/shared/marketplace-copy'

const source = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

const warming = {
  terminalId: 'crew-card',
  agent: true,
  phase: 'thinking',
  prompt: 'Who are you?',
  reply: null
} as TerminalActivity

describe('placed crew transcript parity', () => {
  it('shows an honest LIVE warming state and composer instead of line-mode stdout', () => {
    const html = renderToStaticMarkup(
      <ServedCrewLive terminalId="crew-card" activity={warming} hasTranscript={false} />
    )
    expect(html).toContain('LIVE · LINE WARMING')
    expect(html).toContain('Who are you?')
    expect(html).toContain('aria-label="Ask this crew"')
    expect(html).toContain('aria-label="Send"')
    expect(html).not.toContain('crew-line')
  })

  it('keeps a trace-less gate reply visible after acknowledge demotes it to idle', () => {
    const unavailable = MKT_GATE['mkt.gate.payment.unavailable']
    const html = renderToStaticMarkup(
      <ServedCrewLive
        terminalId="crew-card"
        activity={{ ...warming, phase: 'idle', reply: `transport chrome\n${unavailable}\n>` }}
        hasTranscript={false}
      />
    )
    expect(servedGateReply(`transport chrome\n${unavailable}\n>`)).toBe(unavailable)
    expect(html).toContain('nothing was charged')
    expect(html).not.toContain('transport chrome')
    expect(html).toContain('LIVE')
  })

  it('never renders arbitrary crew-line stdout as a transcript fallback', () => {
    expect(servedGateReply('stack trace\nNode.js\n>')).toBeNull()
  })

  it('feeds remote refreshes through the existing transcript and turn rail components', () => {
    const overlay = source('TerminalOverlay.tsx')
    expect(overlay).toContain('<TranscriptView')
    expect(overlay).toContain('<CheckpointTimeline')
    expect(overlay).toContain('<ServedCrewLive')
    expect(overlay).toContain('refreshToken={remoteCrew ? traceRefresh : 0}')
    expect(overlay).toContain("liveClassName={remoteCrew ? 'served' : undefined}")
    expect(overlay).toContain('allowActions={!remoteCrew}')
    expect(overlay).toContain('cookrew().ptyAttach(node.id, () => undefined)')
    expect(overlay).not.toContain('fetch(`${node.servedTranscript')
  })

  it('keeps checkpoint navigation while withholding local session mutations', () => {
    const html = renderToStaticMarkup(
      <TurnPagerBar
        paging={
          {
            viewing: null,
            position: null,
            count: 2,
            records: null,
            back: () => undefined,
            forward: () => undefined,
            live: () => undefined,
            goto: () => undefined,
            fork: () => undefined,
            forking: false,
            forkable: false
          } satisfies TurnPaging
        }
      />
    )
    expect(html).toContain('Previous checkpoint')
    expect(html).toContain('LIVE · 2 CHECKPOINTS')
    expect(html).not.toContain('Fork a new agent')
  })
})
