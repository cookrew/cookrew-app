// THE WORD UNDER A FACE AGREES WITH THE FACE (Gauge, 2026-11-01: agents whose
// reply was read hours ago said DONE in amber while their face was the bare
// idle face). The word and its colour come from the ink status the face
// draws (zoom/ink-status.ts): a read reply rests, and amber ("done") is the
// unread reply only. The crew, the floating card and the full view's head all
// read the same word.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { statusWord } from '../src/renderer/src/zoom/ink-status'
import { agentViewOf } from '../src/renderer/src/zoom/zoom-model'
import { AgentNode, type Bind } from '../src/renderer/src/zoom/ZoomParts'
import type { AgentRow } from '../src/renderer/src/agent-rows'

const row = (phase: AgentRow['phase'], unread?: boolean): AgentRow =>
  ({ id: 't1', name: 'Tinker', preset: 'Claude Code', role: null, orch: false, active: true, workspaceId: 'w1', workspaceName: 'Dev', cwd: '/x', spawnedAt: 0, phase, turn: null, turnCount: 0, lastActivityAt: 0, unread }) as AgentRow
const bind: Bind = () => () => undefined

describe('the status word', () => {
  it('names each face', () => {
    expect(statusWord('idle')).toBe('resting')
    expect(statusWord('working')).toBe('working')
    expect(statusWord('waiting')).toBe('needs you')
    expect(statusWord('done')).toBe('done')
    expect(statusWord('offline')).toBe('offline')
  })

  it('a reply that was read rests, as the bare face does', () => {
    const read = agentViewOf(row('done', false), new Map())
    expect(read).toMatchObject({ status: 'idle', word: 'resting' })
    const quiet = agentViewOf(row('quiet'), new Map())
    expect(quiet).toMatchObject({ status: 'idle', word: 'resting' })
  })

  it('only an unread reply says done', () => {
    expect(agentViewOf(row('done', true), new Map())).toMatchObject({ status: 'done', word: 'done' })
  })

  it('the crew draws the word in the class of the face, so amber is an unread reply only', () => {
    const read = renderToStaticMarkup(<AgentNode agent={agentViewOf(row('done', false), new Map())} bind={bind} onOpen={() => undefined} card={false} />)
    expect(read).toContain('class="zv-st idle"')
    expect(read).toContain('>resting<')
    expect(read).not.toContain('zv-st done')
    const unread = renderToStaticMarkup(<AgentNode agent={agentViewOf(row('done', true), new Map())} bind={bind} onOpen={() => undefined} card={false} />)
    expect(unread).toContain('class="zv-st done"')
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    expect(css).toMatch(/\.zv-st\.done \{\s*color: var\(--zv-seal-text\)/)
  })

  it('the floating card and the full view head read the same word, not a table of their own', () => {
    const card = readFileSync('src/renderer/src/zoom/AgentCard.tsx', 'utf8')
    expect(card).toContain('className={`zv-st ${agent.status}`}')
    const stage = readFileSync('src/renderer/src/stage/StageView.tsx', 'utf8')
    expect(stage).toContain('statusWord(shownStatus)')
    expect(stage).not.toMatch(/done: 'done', quiet: 'resting'/)
  })
})
