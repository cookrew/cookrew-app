import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentFailure } from '../src/renderer/src/zoom/AgentFailure'
import type { LaunchFailure } from '../src/shared/launch-failure'

const failure: LaunchFailure = {
  kind: 'exited',
  why: 'claude stopped right after it started (exit 1).',
  fix: 'Its last lines are below. Send again to start it again.',
  blocked: false,
  exitCode: 1,
  lastLines: ['Error: <boom>', '  at main'],
  at: 1
}

describe('AgentFailure', () => {
  it('says why, what to do, and what it printed', () => {
    const html = renderToStaticMarkup(<AgentFailure failure={failure} />)
    expect(html).toContain('claude stopped right after it started (exit 1).')
    expect(html).toContain('Send again to start it again.')
    expect(html).toContain('Error: &lt;boom&gt;')
    expect(html).toContain('at main')
  })

  it('draws no empty output block', () => {
    expect(renderToStaticMarkup(<AgentFailure failure={{ ...failure, lastLines: [] }} />)).not.toContain('<pre')
  })
})
