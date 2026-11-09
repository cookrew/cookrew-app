import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../src/renderer/src/api'
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

describe('AgentFailure for a folder Claude would ask about', () => {
  const untrusted: LaunchFailure = {
    kind: 'folder-untrusted',
    why: 'Claude asks before it works in /home/ubuntu, your home folder, and Cookrew does not answer that for you.',
    fix: 'Trust it once (Trust this folder, or: cookrew trust "X"), or give this workspace a project folder. Then send again.',
    blocked: true,
    exitCode: null,
    lastLines: [],
    at: 1
  }
  const bridge = (trustCardFolder: unknown): void => {
    vi.spyOn(api, 'cookrew').mockReturnValue({ trustCardFolder } as unknown as ReturnType<typeof api.cookrew>)
  }
  afterEach(() => vi.restoreAllMocks())

  it('offers the one-press answer on a bridge that has it', () => {
    bridge(vi.fn())
    const html = renderToStaticMarkup(<AgentFailure failure={untrusted} agentId="t1" />)
    expect(html).toContain('Trust this folder')
    expect(html).toContain('/home/ubuntu')
  })

  it('offers no button where the bridge cannot answer, or for any other failure', () => {
    bridge(undefined)
    expect(renderToStaticMarkup(<AgentFailure failure={untrusted} agentId="t1" />)).not.toContain('<button')
    bridge(vi.fn())
    expect(renderToStaticMarkup(<AgentFailure failure={failure} agentId="t1" />)).not.toContain('<button')
  })
})
