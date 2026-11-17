import { describe, expect, it, vi } from 'vitest'
import { CONSOLE_OPEN_MESSAGE, consoleWorkerSource } from '../scripts/console-sw.mjs'
import { parseConsoleRoute } from '../src/renderer/src/console/console-route'

/**
 * THE CONSOLE'S WORKER, WHEN A PUSH ARRIVES (HITL phase 4).
 *
 * The browser has already decrypted the message; the worker shows it, and a
 * press on it opens the console where the agent is waiting. Run here against a
 * browser made of maps, like console-worker.test.ts.
 */

const ORIGIN = 'https://console.cookrew.dev'
const MACHINE = '1a2b3c4d-1111-4111-8111-11111111abcd'

interface Shown {
  title: string
  options: { body: string; tag: string; data: { machineId: string | null; workspaceId: string | null; agentId: string | null }; icon: string }
}

interface Handlers {
  push?: (event: { data: { json: () => unknown } | null; waitUntil: (work: Promise<unknown>) => void }) => void
  notificationclick?: (event: { notification: { data: unknown; close: () => void }; waitUntil: (work: Promise<unknown>) => void }) => void
}

interface FakeClient {
  url: string
  focused: boolean
  focus: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}

function worker(clients: FakeClient[] = []) {
  const handlers: Handlers = {}
  const shown: Shown[] = []
  const opened: string[] = []
  const asked: unknown[] = []
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: never) => void ((handlers as Record<string, unknown>)[type] = handler),
    registration: {
      showNotification: async (title: string, options: Shown['options']) => void shown.push({ title, options })
    },
    clients: {
      claim: async () => undefined,
      matchAll: async (query: unknown) => {
        asked.push(query)
        return clients
      },
      openWindow: async (url: string) => {
        opened.push(url)
        return null
      }
    },
    skipWaiting: () => undefined
  }
  new Function('self', 'caches', 'fetch', consoleWorkerSource({ version: '0.6.0-abc', assets: ['/assets/a.js'] }))(self, {}, vi.fn())
  const push = async (payload: unknown, raw?: { json: () => unknown } | null): Promise<void> => {
    let work: Promise<unknown> = Promise.resolve()
    const data = raw !== undefined ? raw : { json: () => payload }
    handlers.push?.({ data, waitUntil: (given) => void (work = given) })
    await work
  }
  const click = async (data: unknown): Promise<{ closed: number }> => {
    let work: Promise<unknown> = Promise.resolve()
    const state = { closed: 0 }
    handlers.notificationclick?.({ notification: { data, close: () => void (state.closed += 1) }, waitUntil: (given) => void (work = given) })
    await work
    return state
  }
  return { handlers, shown, opened, asked, push, click }
}

const client = (url: string, focused = false): FakeClient => ({ url, focused, focus: vi.fn(async () => undefined), postMessage: vi.fn() })

const GOOD = { v: 1, title: 'Studio Mac · Ada', body: 'Wants to run npm test', tag: 'wait-ada', machineId: MACHINE, workspaceId: 'ws_1', agentId: 'agent-7' }
const GENERIC = { title: 'Cookrew', body: 'An agent needs you' }

describe('a push', () => {
  it('shows the message it carries, with where it came from as the notification’s data', async () => {
    const page = worker()
    await page.push(GOOD)
    expect(page.shown).toEqual([
      {
        title: 'Studio Mac · Ada',
        options: { body: 'Wants to run npm test', tag: 'wait-ada', data: { machineId: MACHINE, workspaceId: 'ws_1', agentId: 'agent-7' }, icon: '/icon-192.png' }
      }
    ])
  })

  it('takes a machine-level message with no workspace or agent', async () => {
    const page = worker()
    await page.push({ ...GOOD, workspaceId: null, agentId: null })
    expect(page.shown[0].options.data).toEqual({ machineId: MACHINE, workspaceId: null, agentId: null })
  })

  it('cuts a long title or body to a notification’s length', async () => {
    const page = worker()
    await page.push({ ...GOOD, title: 't'.repeat(500), body: 'b'.repeat(5000) })
    expect(page.shown[0].title.length).toBeLessThanOrEqual(120)
    expect(page.shown[0].options.body.length).toBeLessThanOrEqual(400)
  })

  it('still shows something for a message it cannot read: a push that shows nothing is penalised', async () => {
    const malformed: unknown[] = [
      null,
      'text',
      { ...GOOD, v: 2 },
      { ...GOOD, title: '' },
      { ...GOOD, title: 7 },
      { ...GOOD, body: null },
      { ...GOOD, tag: undefined },
      { ...GOOD, machineId: 'not-a-machine' },
      { ...GOOD, machineId: MACHINE.toUpperCase() },
      { ...GOOD, workspaceId: '../../evil' },
      { ...GOOD, agentId: 'a/b' },
      { ...GOOD, workspaceId: 5 }
    ]
    for (const payload of malformed) {
      const page = worker()
      await page.push(payload)
      expect(page.shown, JSON.stringify(payload)).toHaveLength(1)
      expect(page.shown[0].title).toBe(GENERIC.title)
      expect(page.shown[0].options).toMatchObject({ body: GENERIC.body, icon: '/icon-192.png', data: { machineId: null, workspaceId: null, agentId: null } })
    }
    for (const raw of [null, { json: () => { throw new SyntaxError('not json') } }]) {
      const page = worker()
      await page.push(undefined, raw)
      expect(page.shown).toHaveLength(1)
      expect(page.shown[0].title).toBe(GENERIC.title)
    }
  })
})

describe('a press on the notification', () => {
  it('opens the agent’s own card when nothing of the console is open', async () => {
    const page = worker()
    const done = await page.click({ machineId: MACHINE, workspaceId: 'ws_1', agentId: 'agent-7' })
    expect(done.closed).toBe(1)
    expect(page.opened).toEqual([`/d/${MACHINE}/w/ws_1/a/agent-7`])
    expect(page.asked).toEqual([{ type: 'window', includeUncontrolled: true }])
  })

  it('opens the workspace, or the machine, when that is all the message names, and the machines for anything else', async () => {
    const cases: [unknown, string][] = [
      [{ machineId: MACHINE, workspaceId: 'ws_1', agentId: null }, `/d/${MACHINE}/w/ws_1`],
      [{ machineId: MACHINE, workspaceId: null, agentId: null }, `/d/${MACHINE}`],
      // An agent with no workspace has no address of its own: its machine.
      [{ machineId: MACHINE, workspaceId: null, agentId: 'agent-7' }, `/d/${MACHINE}`],
      [{ machineId: '//evil.example', workspaceId: null, agentId: null }, '/'],
      [{ machineId: MACHINE, workspaceId: 'a/../../b', agentId: null }, '/'],
      [null, '/'],
      ['/d/x', '/']
    ]
    for (const [data, path] of cases) {
      const page = worker()
      await page.click(data)
      expect(page.opened, JSON.stringify(data)).toEqual([path])
    }
  })

  it('every address it opens is one the console reads as that same place', () => {
    expect(parseConsoleRoute(`/d/${MACHINE}/w/ws_1/a/agent-7`)).toEqual({ kind: 'machine', machine: MACHINE, workspace: 'ws_1', agent: 'agent-7', side: 'agents' })
    expect(parseConsoleRoute(`/d/${MACHINE}/w/ws_1`)).toEqual({ kind: 'machine', machine: MACHINE, workspace: 'ws_1', agent: null, side: 'agents' })
    expect(parseConsoleRoute(`/d/${MACHINE}`)).toEqual({ kind: 'machine', machine: MACHINE, workspace: null, agent: null, side: 'agents' })
  })

  it('brings an open console forward and tells it where to go, rather than opening another', async () => {
    const behind = client(`${ORIGIN}/`)
    const front = client(`${ORIGIN}/d/${MACHINE}`, true)
    const page = worker([behind, front])
    await page.click({ machineId: MACHINE, workspaceId: 'ws_1', agentId: 'agent-7' })
    expect(page.opened).toEqual([])
    expect(front.focus).toHaveBeenCalledTimes(1)
    expect(front.postMessage).toHaveBeenCalledWith({ type: CONSOLE_OPEN_MESSAGE, path: `/d/${MACHINE}/w/ws_1/a/agent-7` })
    expect(behind.postMessage).not.toHaveBeenCalled()
  })

  it('takes the first console when none has focus', async () => {
    const only = client(`${ORIGIN}/`)
    const page = worker([only])
    await page.click({ machineId: MACHINE, workspaceId: null, agentId: null })
    expect(only.focus).toHaveBeenCalledTimes(1)
    expect(only.postMessage).toHaveBeenCalledWith({ type: CONSOLE_OPEN_MESSAGE, path: `/d/${MACHINE}` })
  })

  it('never hands a window of another origin the target', async () => {
    const stranger = client('https://evil.example/')
    const page = worker([stranger])
    await page.click({ machineId: MACHINE, workspaceId: null, agentId: null })
    expect(stranger.postMessage).not.toHaveBeenCalled()
    expect(page.opened).toEqual([`/d/${MACHINE}`])
  })
})
