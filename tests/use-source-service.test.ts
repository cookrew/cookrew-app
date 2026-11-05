// WHAT THE PICKER ASKS OF MAIN (main/use-source-service.ts): a tap makes a
// card in the current workspace, a closed window's card can be pointed at
// something else, and a served workspace is refused before anything is read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVED_USE_REFUSED } from '../src/main/use-commands'
import { cleanAgentName } from '../src/shared/agent-name'
import { createUseSourceService, USE_SOURCES_FRESH_MS, USE_SOURCES_LIST_MS, type UseSourceProvider, type UseSourceServiceDeps } from '../src/main/use-source-service'
import type { BrowserNodeData } from '../src/shared/model'
import type { UseSourceList } from '../src/shared/use-sources'

const list: UseSourceList = {
  state: 'ready',
  windows: [{ id: 'window:41', kind: 'window', title: 'Docs — a very long title that goes on and on and on past what a card can wear in its name', app: 'Safari', address: 'window://Safari?id=41', thumb: null, icon: null, width: 800, height: 600 }],
  screens: [{ id: 'screen:main', kind: 'screen', title: 'Main display', app: null, address: 'screen://main', thumb: null, icon: null, width: 1728, height: 1117 }],
  message: null,
  permission: null,
  windowsNote: null
}
const web: BrowserNodeData = { kind: 'browser', id: 'web', name: 'Web', url: 'https://a.test', position: { x: 0, y: 0 }, size: { width: 720, height: 560 } }
const useCard: BrowserNodeData = { ...web, id: 'use', name: 'Safari', url: 'window://Safari?id=9', tabs: [{ id: 't', url: 'window://Safari?id=9', title: '' }], activeTabId: 't' }

function bed(over: Partial<UseSourceServiceDeps> = {}) {
  let now = 1000
  const provider: UseSourceProvider = { list: vi.fn(async () => list), openSettings: vi.fn(async () => undefined) }
  const added: Array<{ workspaceId: string; card: BrowserNodeData }> = []
  const deps: UseSourceServiceDeps = {
    provider: () => provider,
    servedWorkspace: () => false,
    addCard: (workspaceId, card) => {
      added.push({ workspaceId, card })
      return card
    },
    findCard: (id) => (id === 'web' ? { workspaceId: 'ws', node: web } : id === 'use' ? { workspaceId: 'ws', node: useCard } : null),
    readdress: vi.fn(async (node, url, name) => ({ ...node, url, name })),
    now: () => now,
    newId: () => 'new-id',
    ...over
  }
  return { deps, provider, added, service: createUseSourceService(deps), tick: (ms: number) => (now += ms) }
}

describe('list', () => {
  it('answers the provider', async () => {
    expect(await bed().service.list('ws')).toEqual({ ok: true, value: list })
  })
  it('asks once while a list is in flight or fresh, again when it is stale', async () => {
    const { service, provider, tick } = bed()
    await Promise.all([service.list('ws'), service.list('ws')])
    await service.list('ws')
    expect(provider.list).toHaveBeenCalledTimes(1)
    tick(USE_SOURCES_FRESH_MS + 1)
    await service.list('ws')
    expect(provider.list).toHaveBeenCalledTimes(2)
  })
  it('a platform with no source says so', async () => {
    const answer = await bed({ provider: () => null }).service.list('ws')
    expect(answer).toMatchObject({ ok: true, value: { state: 'unavailable', windows: [], screens: [] } })
  })
})

describe('a source that fails', () => {
  const broken: UseSourceProvider = {
    list: async () => Promise.reject(new Error('capturer died')),
    openSettings: async () => Promise.reject(new Error('no such pane'))
  }
  it('answers in words on every verb, and a failed list is not cached', async () => {
    const { service } = bed({ provider: () => broken })
    expect(await service.list('ws')).toEqual({ ok: false, status: 500, error: 'capturer died' })
    expect(await service.open('ws', { source: 'window:41' })).toEqual({ ok: false, status: 500, error: 'capturer died' })
    expect(await service.openSettings('ws')).toEqual({ ok: false, status: 500, error: 'no such pane' })
  })
  it('a card that cannot be re-pointed says so', async () => {
    const { service } = bed({ readdress: async () => Promise.reject(new Error('Browser node disappeared')) })
    expect(await service.open('ws', { source: 'screen:main', card: 'use' })).toEqual({ ok: false, status: 500, error: 'Browser node disappeared' })
  })
})

describe('a source that never answers', () => {
  afterEach(() => void vi.useRealTimers())

  it('fails at its deadline and is asked again, so one hung capture does not shut the picker until a restart', async () => {
    vi.useFakeTimers()
    const hung: UseSourceProvider = { list: vi.fn(() => new Promise<UseSourceList>(() => undefined)), openSettings: async () => undefined }
    const { service } = bed({ provider: () => hung })
    const first = service.list('ws')
    await vi.advanceTimersByTimeAsync(USE_SOURCES_LIST_MS + 1)
    expect(await first).toMatchObject({ ok: false, status: 500 })
    const second = service.list('ws')
    await vi.advanceTimersByTimeAsync(USE_SOURCES_LIST_MS + 1)
    await second
    expect(hung.list).toHaveBeenCalledTimes(2)
  })
})

describe('what changed while the list was being read', () => {
  /** A provider whose list runs `during` before it answers. */
  const reading = (during: () => void): UseSourceProvider => ({
    list: async () => {
      during()
      return list
    },
    openSettings: async () => undefined
  })

  it('a workspace that became served in the wait is refused, and no card is made', async () => {
    let served = false
    const { service, added } = bed({ provider: () => reading(() => (served = true)), servedWorkspace: () => served })
    expect(await service.open('ws', { source: 'screen:main' })).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(added).toEqual([])
  })

  it('a card deleted in the wait is not found, rather than an ok that changed nothing', async () => {
    let there = true
    const { service, deps } = bed({
      provider: () => reading(() => (there = false)),
      findCard: () => (there ? { workspaceId: 'ws', node: useCard } : null)
    })
    expect(await service.open('ws', { source: 'screen:main', card: 'use' })).toMatchObject({ ok: false, status: 404 })
    expect(deps.readdress).not.toHaveBeenCalled()
  })

  it('a tab switched in the wait is the card that gets re-pointed', async () => {
    let node = useCard
    const moved: BrowserNodeData = { ...useCard, activeTabId: 't2', tabs: [...(useCard.tabs ?? []), { id: 't2', url: 'cam://0', title: '' }] }
    const { service, deps } = bed({ provider: () => reading(() => (node = moved)), findCard: () => ({ workspaceId: 'ws', node }) })
    await service.open('ws', { source: 'screen:main', card: 'use' })
    expect(deps.readdress).toHaveBeenCalledWith(moved, 'screen://main', 'Main display')
  })
})

describe('open', () => {
  it('makes one browser card in the workspace it was asked for, with the bound address and a name a card can wear', async () => {
    const { service, added } = bed()
    const answer = await service.open('ws', { source: 'window:41' })
    expect(answer.ok).toBe(true)
    expect(added).toHaveLength(1)
    expect(added[0].workspaceId).toBe('ws')
    const { card } = added[0]
    expect(card).toMatchObject({ kind: 'browser', id: 'new-id', url: 'window://Safari?id=41', tabs: [{ url: 'window://Safari?id=41' }] })
    expect(card.activeTabId).toBe(card.tabs?.[0].id)
    expect(card.name.length).toBeLessThanOrEqual(60)
    expect(card.name.startsWith('Safari — Docs')).toBe(true)
  })

  it('a card made here wears a name a rename would allow: a title is whatever the app says', async () => {
    const rude: UseSourceProvider = {
      list: async () => ({ ...list, windows: [{ ...list.windows[0], title: 'Docs\tsecond\u0007 line', app: 'Safari' }] }),
      openSettings: async () => undefined
    }
    const { service, added } = bed({ provider: () => rude })
    await service.open('ws', { source: 'window:41' })
    expect(added[0].card.name).toBe(cleanAgentName(added[0].card.name))
    expect(added[0].card.name).not.toMatch(/[\u0000-\u001f]/)
  })

  it('a display is named for itself', async () => {
    const { service, added } = bed()
    await service.open('ws', { source: 'screen:main' })
    expect(added[0].card).toMatchObject({ name: 'Main display', url: 'screen://main' })
  })

  it('takes only source ids: an address, a path or a script is refused before anything is read', async () => {
    const { service, provider, added } = bed()
    for (const source of ['window://Safari', 'window:abc', 'screen:', 'file:///etc/passwd', '', 5, null]) {
      expect(await service.open('ws', { source } as never), String(source)).toMatchObject({ ok: false, status: 400 })
    }
    expect(provider.list).not.toHaveBeenCalled()
    expect(added).toEqual([])
  })

  it('a window no longer listed is a 404 that says only that: it may be minimised, not closed', async () => {
    const { service, added } = bed()
    const answer = await service.open('ws', { source: 'window:77' })
    expect(answer).toMatchObject({ ok: false, status: 404, error: 'That window is no longer in the list — pick another' })
    expect(added).toEqual([])
  })

  it('refuses when there is nothing to read: the grant is missing', async () => {
    const provider: UseSourceProvider = {
      list: async () => ({ ...list, state: 'needs-permission', windows: [], screens: [], message: 'Screen Recording is off', permission: 'Screen Recording' }),
      openSettings: async () => undefined
    }
    expect(await bed({ provider: () => provider }).service.open('ws', { source: 'window:41' })).toMatchObject({ ok: false, status: 409, error: 'Screen Recording is off' })
  })
})

describe('open onto an existing card (the window closed)', () => {
  it('re-addresses the use card in place and makes no new one', async () => {
    const { service, deps, added } = bed()
    const answer = await service.open('ws', { source: 'screen:main', card: 'use' })
    expect(answer).toMatchObject({ ok: true, value: { card: { id: 'use', url: 'screen://main', name: 'Main display' } } })
    expect(deps.readdress).toHaveBeenCalledWith(useCard, 'screen://main', 'Main display')
    expect(added).toEqual([])
  })
  it('will not turn a web card into a screen', async () => {
    const { service, deps } = bed()
    expect(await service.open('ws', { source: 'screen:main', card: 'web' })).toMatchObject({ ok: false, status: 400 })
    expect(deps.readdress).not.toHaveBeenCalled()
  })
  it('a card outside this workspace is not found, and neither is an unknown one', async () => {
    const { service } = bed()
    expect(await service.open('other', { source: 'screen:main', card: 'use' })).toMatchObject({ ok: false, status: 404 })
    expect(await service.open('ws', { source: 'screen:main', card: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })
})

describe('a served workspace', () => {
  const served = (): ReturnType<typeof bed> => bed({ servedWorkspace: (id) => id === 'served' })

  it('cannot list: refused in the served words, and the provider is never asked', async () => {
    const { service, provider } = served()
    expect(await service.list('served')).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(provider.list).not.toHaveBeenCalled()
  })
  it('cannot open, or point a card at anything', async () => {
    const { service, provider, added, deps } = served()
    expect(await service.open('served', { source: 'screen:main' })).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(await service.open('served', { source: 'screen:main', card: 'use' })).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(provider.list).not.toHaveBeenCalled()
    expect(added).toEqual([])
    expect(deps.readdress).not.toHaveBeenCalled()
  })
  it('cannot reach a card in a served workspace from outside it either', async () => {
    const { service, deps } = bed({ servedWorkspace: (id) => id === 'ws' })
    expect(await service.open('elsewhere', { source: 'screen:main', card: 'use' })).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(deps.readdress).not.toHaveBeenCalled()
  })
  it('cannot pop the settings page on the owner\'s Mac', async () => {
    const { service, provider } = served()
    expect(await service.openSettings('served')).toEqual({ ok: false, status: 403, error: SERVED_USE_REFUSED })
    expect(provider.openSettings).not.toHaveBeenCalled()
  })
  it('the cached list of an owner workspace is not an answer for a served one', async () => {
    const { service } = served()
    await service.list('ws')
    expect((await service.list('served')).ok).toBe(false)
  })
})
