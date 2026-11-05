// A SECRET'S ACTIVITY IS ON THE RECORD AND SAID ALOUD (owner 2026-11-05: no
// per-agent rule; "activity and a notification are enough"). Every read, ask,
// seal and delete is a row in Activity and a toast; a person away from the
// window also gets a system notification. Names only, never a value.

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore } from '../src/main/secrets-store'
import { noticeGate, secretNotice, withSecretActivity, NOTICE_QUIET_MS, type SecretChange } from '../src/main/secret-activity'
import { eventDetail, eventMeta, groupedLine, kindFor } from '../src/renderer/src/event-log'
import { secretAuditDetails } from '../src/main/secret-cli'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

const VALUE = 'sk_live_51Hx9QxACTIVITY0000'
const store = () => createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-activity-')) })

describe('a change to the store', () => {
  const watched = () => {
    const changes: SecretChange[] = []
    return { changes, secrets: withSecretActivity(store(), 'Phone', (change) => changes.push(change)) }
  }

  it('says who sealed which name, and never the value', () => {
    const { changes, secrets } = watched()
    secrets.put('stripe-key', VALUE)
    expect(changes).toEqual([{ type: 'secret.sealed', name: 'stripe-key', source: 'Phone' }])
    expect(JSON.stringify(changes)).not.toContain(VALUE)
  })

  it('says a delete only when something went', () => {
    const { changes, secrets } = watched()
    expect(secrets.remove('stripe-key')).toBe(false)
    expect(changes).toEqual([])
    secrets.put('stripe-key', VALUE)
    expect(secrets.remove('stripe-key')).toBe(true)
    expect(changes.at(-1)).toEqual({ type: 'secret.removed', name: 'stripe-key', source: 'Phone' })
  })

  it('says nothing of a seal that failed', () => {
    const { changes, secrets } = watched()
    expect(() => secrets.put('Not A Name', VALUE)).toThrow()
    expect(changes).toEqual([])
  })

  it('leaves the rest of the store as it was: a read is audited above it, and the scrub must not be', () => {
    const { changes, secrets } = watched()
    secrets.put('stripe-key', VALUE)
    expect(secrets.read('stripe-key')?.value).toBe(VALUE)
    expect(secrets.list().map((row) => row.name)).toEqual(['stripe-key'])
    expect(changes).toHaveLength(1)
  })
})

describe('the row and the toast', () => {
  it('reads as a sentence for each kind of activity', () => {
    expect(eventMeta('secret.read')).toMatchObject({ label: 'Secret', verb: 'read a secret', icon: 'lock' })
    expect(eventMeta('secret.requested').verb).toBe('asked for a secret')
    expect(eventMeta('secret.sealed').verb).toBe('sealed a secret')
    expect(eventMeta('secret.removed').verb).toBe('deleted a secret')
    expect(kindFor('secret.removed')).toBe('remove')
  })

  it('toasts, and counts a burst in words', () => {
    for (const type of ['secret.read', 'secret.requested', 'secret.sealed', 'secret.removed']) expect(eventMeta(type).toast).toBeUndefined()
    expect(groupedLine('secret.read', 3)).toBe('3 secrets read')
    expect(groupedLine('secret.requested', 2)).toBe('2 secrets asked for')
  })

  it('counts in no metric: a read is not a card made or removed', () => {
    for (const type of ['secret.read', 'secret.requested', 'secret.sealed', 'secret.removed']) expect(eventMeta(type).metric).toBeNull()
  })

  it('shows the name, not the note id the inbox needs', () => {
    const details = secretAuditDetails('stripe-key', [{ id: 'n-1', content: '🔒 stripe-key\n' }])
    expect(details).toBe('stripe-key note:n-1')
    expect(eventDetail({ type: 'secret.read', details })).toBe('stripe-key')
    expect(eventDetail({ type: 'secret.read', details: 'stripe-key' })).toBe('stripe-key')
    expect(eventDetail({ type: 'dispatch.failed', details: 'a note:b' })).toBe('a note:b')
    expect(eventDetail({ type: 'secret.read' })).toBeUndefined()
  })

  it('is what both surfaces draw', () => {
    expect(readFileSync('src/renderer/src/EventToast.tsx', 'utf8')).toContain('details: eventDetail(event)')
    expect(readFileSync('src/renderer/src/MetricsPanel.tsx', 'utf8')).toContain('eventDetail(event)')
  })
})

describe('the system notification', () => {
  it('names who did what to which secret', () => {
    expect(secretNotice('secret.read', 'Tinker', 'stripe-key')).toBe('Tinker read the secret stripe-key')
    expect(secretNotice('secret.requested', 'Tinker', 'stripe-key')).toBe('Tinker asked for the secret stripe-key')
    expect(secretNotice('secret.sealed', 'Phone', 'stripe-key')).toBe('Phone sealed the secret stripe-key')
    expect(secretNotice('secret.removed', 'Phone', 'stripe-key')).toBe('Phone deleted the secret stripe-key')
  })

  it('is said once a while for one agent and one name: Activity keeps every row', () => {
    let now = 1_000
    const gate = noticeGate(() => now)
    expect(gate('secret.read|Tinker|a-key')).toBe(true)
    expect(gate('secret.read|Tinker|a-key')).toBe(false)
    expect(gate('secret.read|Forge|a-key')).toBe(true)
    expect(gate('secret.read|Tinker|b-key')).toBe(true)
    expect(gate('secret.removed|Tinker|a-key')).toBe(true)
    now += NOTICE_QUIET_MS - 1
    expect(gate('secret.read|Tinker|a-key')).toBe(false)
    now += 1
    expect(gate('secret.read|Tinker|a-key')).toBe(true)
  })

  it('does not grow with every name it has seen', () => {
    let now = 0
    const gate = noticeGate(() => now)
    for (let i = 0; i < 5000; i += 1) gate(`k${i}`)
    now += NOTICE_QUIET_MS
    gate('after')
    expect(gate.size()).toBe(1)
  })
})

// The phone's toast rides /api/events, which listens to store ops; a secret's
// activity is not one. The same stream serves the wall and a page with no token.
describe('the live stream', () => {
  const OWNER = 'pairing-token-123'
  const WALL = 'wall-token-456'
  const ROW = { type: 'secret.read', entityId: 't1', entityName: 'Tinker', workspaceId: 'w', workspaceName: 'W', actor: 'agent', timestamp: 1, details: 'stripe-key note:n-1' }

  async function open(token: string | null): Promise<{ events: EventEmitter; text: () => string; close: () => void }> {
    const request = new EventEmitter() as unknown as http.IncomingMessage
    request.method = 'GET'
    request.headers = token ? { authorization: `Bearer ${token}` } : {}
    const written: string[] = []
    const response = Object.assign(new EventEmitter(), {
      req: request,
      writableEnded: false,
      destroyed: false,
      setHeader: () => undefined,
      writeHead: () => response,
      write: (chunk: string) => (written.push(String(chunk)), true),
      end: (chunk?: string) => (chunk && written.push(String(chunk)), response)
    }) as unknown as http.ServerResponse
    const events = new EventEmitter()
    const deps = {
      pairingToken: OWNER,
      wallToken: WALL,
      store: Object.assign(new EventEmitter(), { focusedState: { name: 'ws', dir: '/tmp', nodes: [], connections: [] } }),
      turns: Object.assign(new EventEmitter(), { list: () => [] }),
      events,
      ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'w' }) }
    } as unknown as MobileApiDeps
    await handleMobileApi(request, response, new URL('http://lan.local/api/events'), deps)
    return {
      events,
      text: () => written.join(''),
      close: () => {
        request.emit('close')
        response.emit('close')
      }
    }
  }

  it('carries the row to the owner, and stops when the page goes', async () => {
    const stream = await open(OWNER)
    stream.events.emit('event', ROW)
    expect(stream.text()).toContain('stripe-key')
    stream.close()
    expect(stream.events.listenerCount('event')).toBe(0)
  })

  it('leaves out every other logged event: those already ride as store ops', async () => {
    const stream = await open(OWNER)
    stream.events.emit('event', { ...ROW, type: 'note.created', details: 'not-doubled' })
    expect(stream.text()).not.toContain('not-doubled')
    stream.close()
  })

  it('tells the wall and a page with no token nothing', async () => {
    for (const token of [WALL, null]) {
      const stream = await open(token)
      stream.events.emit('event', ROW)
      expect(stream.text()).not.toContain('stripe-key')
      expect(stream.text()).not.toContain('secret.read')
      stream.close()
    }
  })
})

describe('the app', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')

  it('records a write from either door, and tells the away owner of every kind', () => {
    expect(main).toContain("withSecretActivity(secrets, 'This Mac', recordSecretChange)")
    expect(main).toContain("withSecretActivity(secrets, 'Phone', recordSecretChange)")
    // The audit of a read or an ask, and a seal or a delete.
    expect(main.split('noticeSecret(').length).toBe(3)
  })

  it('only speaks over the window when nobody is looking at it', () => {
    expect(main).toContain('mainWindow?.isFocused()')
  })
})
