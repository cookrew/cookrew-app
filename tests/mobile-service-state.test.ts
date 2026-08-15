import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { HotCapacityError, MAX_HOT_WORKSPACES } from '../src/main/store'
import type { WorkspaceMeta, WorkspaceServiceState } from '../src/shared/model'

function request(body: unknown): http.IncomingMessage {
  const message = Readable.from([JSON.stringify(body)]) as http.IncomingMessage
  message.method = 'POST'
  message.headers = {}
  return message
}

function response(): {
  value: http.ServerResponse
  captured: { status: number; body: unknown }
} {
  const captured = { status: 0, body: undefined as unknown }
  const value = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(raw?: string) {
      captured.body = raw ? JSON.parse(raw) : undefined
    }
  } as unknown as http.ServerResponse
  return { value, captured }
}

const WORKSPACE: WorkspaceMeta = {
  id: 'ws-1',
  name: 'Service Workspace',
  dir: '/work/service',
  dirs: ['/work/service'],
  icon: 'S',
  serviceState: 'dormant'
}

function deps(workspaces: WorkspaceMeta[] = [WORKSPACE]): {
  value: MobileApiDeps
  setState: ReturnType<typeof vi.fn>
} {
  const setState = vi.fn((id: string, state: WorkspaceServiceState) => ({
    ...WORKSPACE,
    id,
    serviceState: state
  }))
  return {
    value: {
      ops: {
        listWorkspaces: () => ({ workspaces, activeId: WORKSPACE.id }),
        setWorkspaceServiceState: setState
      }
    } as unknown as MobileApiDeps,
    setState
  }
}

const url = (id = 'ws-1'): URL =>
  new URL(`/api/workspaces/${id}/service`, 'http://lan.local')

describe('POST /api/workspaces/:id/service', () => {
  it('updates the state and returns the updated workspace metadata', async () => {
    const d = deps()
    const out = response()

    const handled = await handleMobileApi(request({ state: 'hot' }), out.value, url(), d.value)

    expect(handled).toBe(true)
    expect(out.captured.status).toBe(200)
    expect(d.setState).toHaveBeenCalledWith('ws-1', 'hot')
    expect(out.captured.body).toMatchObject({ id: 'ws-1', serviceState: 'hot' })
  })

  it('returns 400 for a state outside the closed vocabulary', async () => {
    const d = deps()
    const out = response()

    await handleMobileApi(request({ state: 'warming' }), out.value, url(), d.value)

    expect(out.captured.status).toBe(400)
    expect(out.captured.body).toMatchObject({ error: expect.stringMatching(/hot.*dormant.*parked/) })
    expect(d.setState).not.toHaveBeenCalled()
  })

  it('returns 404 when the workspace does not exist', async () => {
    const d = deps([])
    const out = response()

    await handleMobileApi(request({ state: 'hot' }), out.value, url('missing'), d.value)

    expect(out.captured.status).toBe(404)
    expect(out.captured.body).toMatchObject({ error: expect.stringMatching(/not found/i) })
    expect(d.setState).not.toHaveBeenCalled()
  })

  it('returns 409 — not 500 — when the HOT ceiling is full (D9)', async () => {
    // A full fleet is a refusal the server made on purpose, the same answer
    // /dispatch gives a busy agent. Reaching the catch-all reported 500, which
    // tells a correct client the server broke and invites a blind retry.
    const d = deps()
    d.setState.mockImplementation(() => {
      throw new HotCapacityError()
    })
    const out = response()

    const handled = await handleMobileApi(request({ state: 'hot' }), out.value, url(), d.value)

    expect(handled).toBe(true)
    expect(out.captured.status).toBe(409)
    // Actionable: the limit is what tells the caller to park something first.
    expect(out.captured.body).toMatchObject({
      error: expect.stringMatching(/capacity reached/i),
      limit: MAX_HOT_WORKSPACES,
      state: 'hot'
    })
  })

  it('still surfaces an UNEXPECTED failure as a fault, not as capacity', async () => {
    // 409 means "try later"; a broken store does not, and dressing every throw
    // as capacity would hide the bug behind a retry loop.
    const d = deps()
    d.setState.mockImplementation(() => {
      throw new Error('registry write failed')
    })
    const out = response()

    await expect(
      handleMobileApi(request({ state: 'hot' }), out.value, url(), d.value)
    ).rejects.toThrow(/registry write failed/)
  })
})
