import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StrayRows, strayEndHint } from '../src/renderer/src/StrayPanes'
import type { StrayPane } from '../src/shared/stray-pane'

const proved: StrayPane = { session: 'cookrew_a', terminalId: 'a', name: 'Lark', cwd: '/work/lark', workspaceName: 'Alpha', proved: true }
const unknown: StrayPane = { session: 'cookrew_b', terminalId: null, name: null, cwd: null, workspaceName: null, proved: false }

describe('StrayRows', () => {
  it('draws nothing when no pane lost its card', () => {
    expect(renderToStaticMarkup(<StrayRows strays={[]} onEnd={vi.fn()} onRecover={vi.fn()} busy={null} />)).toBe('')
  })

  it('a proved pane says who it is, where it runs, and can be ended or taken back', () => {
    const html = renderToStaticMarkup(<StrayRows strays={[proved]} onEnd={vi.fn()} onRecover={vi.fn()} busy={null} />)
    expect(html).toContain('Running without a card')
    expect(html).toContain('Lark')
    expect(html).toContain('/work/lark')
    expect(html).toContain('END')
    expect(html).toContain('RECOVER')
  })

  it('an unproved pane is shown with NO button that could end it', () => {
    const html = renderToStaticMarkup(<StrayRows strays={[unknown]} onEnd={vi.fn()} onRecover={vi.fn()} busy={null} />)
    expect(html).toContain('cookrew_b')
    expect(html).toContain(strayEndHint(unknown))
    expect(html).not.toContain('END')
    expect(html).not.toContain('RECOVER')
  })
})
