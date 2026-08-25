// The §11 outcome through the real handler: a client served at /<slug> reads
// that workspace, while the desktop looks at another one.
//
// slug-stream-scope.test.ts pins the SIGNAL layer. This pins the two ends the
// signal runs between: the boot script the client is served, and the canvas
// handleMobileApi answers with when a scope travels on the request.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { remoteBoot } from '../src/main/mobile-server'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { WorkspaceStore } from '../src/main/store'
import type { TerminalNodeData } from '../src/shared/model'

function terminal(name: string): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `id-${name}`,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

function stubRequest(method = 'GET'): http.IncomingMessage {
  const request = Readable.from([]) as http.IncomingMessage
  request.method = method
  request.headers = {}
  return request
}

function stubResponse(): {
  response: http.ServerResponse
  captured: { status: number; body: unknown }
} {
  const captured = { status: 0, body: undefined as unknown }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(raw?: string) {
      captured.body = raw ? JSON.parse(raw) : undefined
    }
  } as unknown as http.ServerResponse
  return { response, captured }
}

describe('the boot script tells the client which workspace it is for', () => {
  it('carries the slug when served under one', () => {
    expect(remoteBoot('playground')).toContain('window.COOKREW_SLUG = "playground"')
  })

  it('carries an empty slug at the unslugged root', () => {
    // api-base then makes apiPath the identity, so every existing phone
    // bookmark keeps behaving exactly as it did.
    expect(remoteBoot(null)).toContain('window.COOKREW_SLUG = ""')
  })

  it('escapes so a hostile slug cannot close the script tag', () => {
    // Caught a real hole when written: JSON.stringify escapes quotes and
    // backslashes but NOT '<' or '/', so `</script>` survived it intact. The
    // route splitter allow-lists the minted shape, so this was unreachable —
    // but a lock that only works because of the other lock is not a lock.
    const hostile = remoteBoot('</script><script>alert(1)//')
    expect(hostile).not.toContain('</script><script>alert(1)')
    expect(hostile).toContain('\\u003c')
  })

  it('leaves an ordinary slug readable', () => {
    expect(remoteBoot('my-project-2')).toContain('window.COOKREW_SLUG = "my-project-2"')
  })
})

describe('a scoped request reads the workspace its URL names', () => {
  function twoWorkspaces(): { deps: (scope: string | null) => MobileApiDeps; play: string } {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-boot-')), {
      multiInstance: true
    })
    store.addNode({ ...terminal('In dev'), id: 'id-dev' })
    const play = store.createWorkspace('Playground', '/work/play').id
    store.addNodeToWorkspace(play, { ...terminal('In play'), id: 'id-play' })
    // The desktop is looking at the FIRST workspace throughout.
    const deps = (scope: string | null): MobileApiDeps =>
      ({
        store,
        scope,
        ptys: { get: () => undefined },
        turns: { list: () => [] },
        ops: { gitInfo: () => undefined, listWorkspaces: () => store.list() },
        presets: []
      }) as unknown as MobileApiDeps
    return { deps, play }
  }

  it('answers /api/workspace with the SCOPED canvas, not the focused one', async () => {
    const { deps, play } = twoWorkspaces()
    const { response, captured } = stubResponse()

    await handleMobileApi(
      stubRequest(),
      response,
      new URL('/api/workspace', 'http://lan.local'),
      deps(play)
    )

    const nodes = (captured.body as { nodes: { id: string }[] }).nodes
    expect(nodes.map((n) => n.id)).toEqual(['id-play'])
    expect(nodes.map((n) => n.id)).not.toContain('id-dev')
  })

  it('answers the UNSCOPED request with the focused canvas, as it always did', async () => {
    const { deps } = twoWorkspaces()
    const { response, captured } = stubResponse()

    await handleMobileApi(
      stubRequest(),
      response,
      new URL('/api/workspace', 'http://lan.local'),
      deps(null)
    )

    const nodes = (captured.body as { nodes: { id: string }[] }).nodes
    expect(nodes.map((n) => n.id)).toEqual(['id-dev'])
  })

  it('the two answers differ — which is the whole point', async () => {
    const { deps, play } = twoWorkspaces()
    const scoped = stubResponse()
    const unscoped = stubResponse()
    const url = (): URL => new URL('/api/workspace', 'http://lan.local')

    await handleMobileApi(stubRequest(), scoped.response, url(), deps(play))
    await handleMobileApi(stubRequest(), unscoped.response, url(), deps(null))

    expect(scoped.captured.body).not.toEqual(unscoped.captured.body)
  })
})
