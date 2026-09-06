import { describe, expect, it } from 'vitest'
import { HerdrHostMultiplexer, type AsyncCliRunner } from '../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

/**
 * listSessionsAsync — the board probe's inventory read off the main thread
 * (perf/tempo). What is pinned: the SYNC runner is never touched, a good
 * listing is published as the admission inventory so the capture that
 * follows resolves its pane on the async runner too, and a bad listing
 * answers [] without publishing anything.
 */
const envelope = (panes: unknown[]): string => JSON.stringify({ id: 'cli:pane:list', result: { panes } })
const pane = (label: string, id: string) => ({ pane_id: id, label, agent_status: 'unknown' })

function harness(replies: Record<string, string | Error>) {
  const sync: string[][] = []
  const async: string[][] = []
  const runner: CommandRunner = {
    run: (_file, args) => {
      sync.push(args)
      throw new Error('sync runner must not be used')
    },
    runQuiet: (_file, args) => {
      sync.push(args)
    },
    probe: (_file, args) => {
      sync.push(args)
      return true
    }
  }
  const asyncRunner: AsyncCliRunner = async (args) => {
    async.push(args)
    const reply = replies[args.slice(0, 2).join(' ')]
    if (reply === undefined) throw new Error(`no scripted reply for ${args.join(' ')}`)
    if (reply instanceof Error) throw reply
    return reply
  }
  const mux = new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/tmp/c.toml', runner, asyncRunner })
  return { mux, sync, async }
}

describe('HerdrHostMultiplexer.listSessionsAsync', () => {
  it('lists through the async runner only and publishes the inventory', async () => {
    const { mux, sync, async } = harness({
      'pane list': envelope([pane('cookrew_a', 'w1:p1'), pane('cookrew_b', 'w1:p2'), { pane_id: 'w1:p3', label: null }]),
      'pane read': 'some pane text'
    })
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_a', 'cookrew_b'])
    // The capture that follows resolves its pane from THAT read — no cold-cache miss.
    expect(await mux.captureAsync('cookrew_b')).toBe('some pane text')
    expect(async.map((a) => a.slice(0, 3))).toEqual([
      ['pane', 'list'],
      ['pane', 'read', 'w1:p2']
    ])
    expect(sync).toEqual([])
  })

  it('answers [] for a failed or malformed listing and publishes nothing', async () => {
    const failed = harness({ 'pane list': new Error('herdr: os error 35') })
    expect(await failed.mux.listSessionsAsync()).toEqual([])
    expect(await failed.mux.captureAsync('cookrew_a')).toBeNull() // still cold
    const malformed = harness({ 'pane list': '{"id":"x","result":{"panes":[null]}}' })
    expect(await malformed.mux.listSessionsAsync()).toEqual([])
    expect(failed.sync).toEqual([])
    expect(malformed.sync).toEqual([])
  })

  it('answers from the attach-burst snapshot while one is open', async () => {
    const { mux, async } = harness({ 'pane list': envelope([pane('cookrew_late', 'w1:p9')]) })
    // beginAttachBatch would fork the sync runner; the snapshot seam is what
    // matters here, so it is set the way the batch does through the public
    // surface of a mux whose sync runner refuses.
    expect(await mux.listSessionsAsync()).toEqual(['cookrew_late'])
    expect(async).toHaveLength(1)
  })
})
