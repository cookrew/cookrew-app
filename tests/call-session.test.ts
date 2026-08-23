import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeCallSession } from '../src/main/call-session'
import { CallConversationStore, isConversationId } from '../src/main/call-conversation'

/**
 * ONE FORK PER CALLER-CONVERSATION (④ · S3).
 *
 * The ruling made checkable. §10 read literally would fork per HTTP request;
 * these pin the behaviour that replaced it — including that the SAFE shape is
 * what a caller gets by doing nothing.
 */

const WS = 'ws-cookrew-dev'
const NODE = 'node-forge'

let base = ''
let conversations: CallConversationStore
let cuts = 0
let alive = new Set<string>()
const clock = 1_700_000_000_000

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-call-session-'))
  conversations = new CallConversationStore(base)
  cuts = 0
  alive = new Set<string>()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const session = (): ReturnType<typeof makeCallSession> =>
  makeCallSession({
    conversations,
    cutVersion: (sourceId) => {
      cuts += 1
      const forkId = `fork-${sourceId}-${cuts}`
      alive.add(forkId)
      return {
        forkId,
        forkName: `Forge ⑂T${cuts}`,
        pin: { version: cuts, atIndex: 7, scrollLine: 100, cutAt: clock }
      }
    },
    forkAlive: (forkId) => alive.has(forkId),
    now: () => clock
  })

describe('the conversation is the unit, not the request', () => {
  it('cuts a version on the first call', () => {
    const first = session()({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(first.cut).toBe(true)
    expect(first.version).toBe(1)
    expect(cuts).toBe(1)
  })

  it('does NOT cut again on the second call — this is the whole ruling', () => {
    const s = session()
    const first = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    const second = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(second.cut).toBe(false)
    expect(second.forkId).toBe(first.forkId)
    expect(second.version).toBe(1)
    expect(cuts).toBe(1)
  })

  it('stays at one version across many turns', () => {
    const s = session()
    for (let i = 0; i < 20; i += 1) s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    // Twenty turns of a conversation are one version, not twenty pins on the
    // rail. Pins are permanent, named and addressable; diamonds are the
    // ephemeral ones.
    expect(cuts).toBe(1)
  })

  it('gives a caller that names nothing its own default conversation', () => {
    // The safe shape is what happens when a client does nothing, rather than
    // something it must remember to opt into.
    const first = session()({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(first.conversation).toBe('default')
  })
})

describe('conversations are scoped by caller, never merely named', () => {
  it('does not let one caller join another caller\'s conversation', () => {
    const s = session()
    const alice = s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'c1' })
    const bob = s({ workspaceId: WS, nodeId: NODE, sub: 'bob', conversation: 'c1' })
    expect(bob.forkId).not.toBe(alice.forkId)
    expect(cuts).toBe(2)
  })

  it('keeps a caller\'s parallel conversations apart', () => {
    const s = session()
    const one = s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'one' })
    const two = s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'two' })
    expect(two.forkId).not.toBe(one.forkId)
    expect(s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'one' }).forkId).toBe(
      one.forkId
    )
  })

  it('keeps the same caller\'s conversations with two agents apart', () => {
    const s = session()
    const forge = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    const atlas = s({ workspaceId: WS, nodeId: 'node-atlas', sub: 'alice' })
    expect(atlas.forkId).not.toBe(forge.forkId)
  })

  it('keeps the same agent id in two workspaces apart', () => {
    const s = session()
    const here = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    const there = s({ workspaceId: 'ws-playground', nodeId: NODE, sub: 'alice' })
    expect(there.forkId).not.toBe(here.forkId)
  })
})

describe('a conversation outlives its credential and its process', () => {
  it('resumes after a relaunch — nothing here is keyed on a token', () => {
    session()({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    const relaunched = makeCallSession({
      conversations: new CallConversationStore(base),
      cutVersion: () => {
        cuts += 1
        throw new Error('should not cut again')
      },
      forkAlive: (forkId) => alive.has(forkId),
      now: () => clock
    })
    const resumed = relaunched({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(resumed.cut).toBe(false)
    expect(cuts).toBe(1)
  })

  it('re-forks when the owner deleted the fork, and that is a NEW version', () => {
    const s = session()
    const first = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    alive.delete(first.forkId)
    const second = s({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(second.cut).toBe(true)
    expect(second.version).toBe(2)
    expect(second.forkId).not.toBe(first.forkId)
  })

  it('records nothing when the cut fails', () => {
    const failing = makeCallSession({
      conversations,
      cutVersion: () => {
        throw new Error('no completed turns to cut a version from')
      },
      forkAlive: () => true,
      now: () => clock
    })
    expect(() => failing({ workspaceId: WS, nodeId: NODE, sub: 'alice' })).toThrow()
    // A conversation pointing at a fork that was never made would resume onto
    // nothing, forever.
    expect(conversations.find(WS, NODE, 'alice', 'default')).toBeNull()
  })

  it('treats a corrupt conversation file as no conversations', () => {
    mkdirSync(base, { recursive: true })
    writeFileSync(path.join(base, 'call-conversations.json'), '{ not json')
    const fresh = new CallConversationStore(base)
    expect(fresh.find(WS, NODE, 'alice', 'default')).toBeNull()
  })

  it('never hands back the ORIGINAL terminal as the thing to run against', () => {
    // The property that keeps a stranger out of the owner's input box.
    const s = session()
    for (const sub of ['alice', 'bob']) {
      for (const conversation of ['default', 'c1']) {
        const result = s({ workspaceId: WS, nodeId: NODE, sub, conversation })
        expect(result.forkId).not.toBe(NODE)
      }
    }
  })
})

describe('a conversation id is a key', () => {
  it('accepts ordinary ids', () => {
    for (const id of ['default', 'c1', 'thread-2026-08-22', 'A.b_c-1']) {
      expect(isConversationId(id)).toBe(true)
    }
  })

  it('refuses anything that would become two spellings of one name', () => {
    for (const id of ['', '../escape', 'has space', 'a/b', '-leading', 'x'.repeat(65), '💬']) {
      expect(isConversationId(id)).toBe(false)
    }
  })
})

describe('the store keeps its own bookkeeping honest', () => {
  it('replaces rather than accumulating for one key', () => {
    const entry = {
      workspaceId: WS,
      nodeId: NODE,
      sub: 'alice',
      conversation: 'default',
      forkId: 'f1',
      version: 1,
      startedAt: clock
    }
    conversations.record(entry)
    conversations.record({ ...entry, forkId: 'f2', version: 2 })
    expect(conversations.find(WS, NODE, 'alice', 'default')).toMatchObject({ forkId: 'f2' })
  })

  it('forgets exactly one conversation', () => {
    const s = session()
    s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'one' })
    s({ workspaceId: WS, nodeId: NODE, sub: 'alice', conversation: 'two' })
    conversations.forget(WS, NODE, 'alice', 'one')
    expect(conversations.find(WS, NODE, 'alice', 'one')).toBeNull()
    expect(conversations.find(WS, NODE, 'alice', 'two')).not.toBeNull()
  })

  it('does not consult the fork liveness check for a conversation it never had', () => {
    const forkAlive = vi.fn(() => true)
    makeCallSession({
      conversations,
      cutVersion: () => ({
        forkId: 'f1',
        forkName: 'f',
        pin: { version: 1, atIndex: 1, scrollLine: 0, cutAt: clock }
      }),
      forkAlive,
      now: () => clock
    })({ workspaceId: WS, nodeId: NODE, sub: 'alice' })
    expect(forkAlive).not.toHaveBeenCalled()
  })
})
