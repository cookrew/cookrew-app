import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  makeConductorRoute,
  makeEnder,
  makeMinter,
  makeTemplateSource,
  type ForkEngine
} from '../src/main/session-instantiator-adapters'
import { sessionIdentity } from '../src/main/session-identity'

/**
 * THE ADAPTERS route the orchestrator to the real machinery. These prove the
 * routing is correct — the sandbox is created and becomes HOME, the env carries
 * only what was granted, END cuts by workspace and removes the right path — with
 * the subsystems on the far side of each narrow handle faked.
 */

let base = ''
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'inst-adapters-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('makeTemplateSource', () => {
  it('resolves a service to its local template at a pin, reading each source once', () => {
    let loads = 0
    let resolves = 0
    const source = makeTemplateSource(
      (svc) => `tmpl-${svc}`,
      {
        load: (id) => {
          loads++
          return id === 'tmpl-svc' ? { name: id } : undefined
        }
      },
      {
        resolve: () => {
          resolves++
          return { version: 3, pinAddress: 'sha256:abc' }
        }
      }
    )
    expect(source.read('svc')).toEqual({ templateId: 'tmpl-svc', version: 3, pinAddress: 'sha256:abc' })
    // One read = one load + one pin resolve; the resolved-once-at-mint property
    // the orchestrator relies on starts with the adapter not double-reading.
    expect(loads).toBe(1)
    expect(resolves).toBe(1)
  })

  it('refuses a template this machine does not hold (local-first, S1b)', () => {
    const source = makeTemplateSource(
      () => 'missing',
      { load: () => undefined },
      { resolve: () => ({ version: 1, pinAddress: 'x' }) }
    )
    expect(() => source.read('svc')).toThrow(/not on this machine/)
  })
})

describe('makeMinter — lays down the sandbox, then forks rooted there', () => {
  it('creates the sandbox dir and forks the template into it with the session identity', async () => {
    const forked: Parameters<ForkEngine['fork']>[0][] = []
    const engine: ForkEngine = {
      fork: async (input) => {
        forked.push(input)
        return `ws-${input.name}`
      }
    }
    const minter = makeMinter({ base, engine })
    const identity = sessionIdentity('svc', 'ana', 1)
    const workspaceId = await minter.mint({
      serviceId: 'svc',
      identity,
      template: { templateId: 'tmpl-svc', version: 1, pinAddress: 'sha256:v1' }
    })

    expect(workspaceId).toBe(`ws-${identity.workspaceName}`)
    expect(forked).toHaveLength(1)
    const [input] = forked
    // The sandbox exists and is the fork's cwd; the identity rides along so the
    // spawn-time confinement (servedConfinement) has the service + session it
    // needs. The env itself is applied at spawn, not here.
    expect(existsSync(input.dir)).toBe(true)
    expect(input.templateId).toBe('tmpl-svc')
    expect(input.serviceId).toBe('svc')
    expect(input.sessionId).toBe(identity.sessionId)
  })
})

describe('makeMinter — cleans up on failure', () => {
  it('removes the sandbox it created if the fork fails, leaving nothing behind', async () => {
    const removed: string[] = []
    const minter = makeMinter({
      base,
      engine: { fork: async () => { throw new Error('fork boom') } },
      remover: { remove: (dir) => removed.push(dir) }
    })
    const identity = sessionIdentity('svc', 'ana', 1)
    await expect(
      minter.mint({
        serviceId: 'svc',
        identity,
        template: { templateId: 't', version: 1, pinAddress: 'x' }
      })
    ).rejects.toThrow('fork boom')
    // The dir sandboxRoot made is the dir the remover was handed (realpathed, so
    // compare by suffix rather than the pre-symlink base).
    expect(removed).toHaveLength(1)
    // The service prefix is NOT repeated in the segment (sun_path headroom).
    expect(removed[0].endsWith(path.join('sessions', 'svc', 'ana-1'))).toBe(true)
  })
})

describe('makeConductorRoute', () => {
  it('routes a workspace to its entry terminal', () => {
    const route = makeConductorRoute({ entryTerminalOf: (id) => (id === 'ws-1' ? 'term-orch' : null) })
    expect(route.conductorOf('ws-1')).toBe('term-orch')
    expect(route.conductorOf('ws-x')).toBeNull()
  })
})

describe('makeEnder — cut by workspace, remove the right sandbox', () => {
  it('cancels exactly the calls in the session workspace', () => {
    const seen: string[] = []
    const ender = makeEnder({
      base,
      cutter: {
        cancelWhere: (match) => {
          // Two calls, one in this workspace, one elsewhere.
          const calls = [{ workspaceId: 'ws-ana' }, { workspaceId: 'ws-bob' }]
          const cut = calls.filter(match)
          seen.push(...cut.map((c) => c.workspaceId))
          return cut.length
        }
      },
      remover: { remove: () => undefined }
    })
    const stopped = ender.cut({ sessionId: 'svc-ana-1', workspaceId: 'ws-ana', serviceId: 'svc' })
    expect(stopped).toBe(1)
    expect(seen).toEqual(['ws-ana'])
  })

  it('removes the sandbox by the same path sandboxRoot built', () => {
    const removed: string[] = []
    const ender = makeEnder({
      base,
      cutter: { cancelWhere: () => 0 },
      remover: { remove: (dir) => removed.push(dir) }
    })
    ender.cleanup({ sessionId: 'svc-ana-1', workspaceId: 'ws-ana', serviceId: 'svc' })
    expect(removed).toEqual([path.join(base, 'sessions', 'svc', 'ana-1')])
  })

  it('removes the very dir the minter created — round-trip through a real rm', async () => {
    // The minter creates via sandboxRoot (realpathed); the ender builds the path
    // lexically. On a symlinked base the strings differ, so this proves they
    // still resolve to one dir: mint, then a real rm, then it is gone.
    let sandboxDir = ''
    const minter = makeMinter({
      base,
      engine: {
        fork: async (input) => {
          sandboxDir = input.dir
          return 'ws-ana'
        }
      }
    })
    await minter.mint({
      serviceId: 'svc',
      identity: sessionIdentity('svc', 'ana', 1),
      template: { templateId: 't', version: 1, pinAddress: 'x' }
    })
    expect(existsSync(sandboxDir)).toBe(true)

    const ender = makeEnder({
      base,
      cutter: { cancelWhere: () => 0 },
      remover: { remove: (dir) => rmSync(dir, { recursive: true, force: true }) }
    })
    ender.cleanup({ sessionId: 'svc-ana-1', workspaceId: 'ws-ana', serviceId: 'svc' })
    expect(existsSync(sandboxDir)).toBe(false)
  })

  it('cleanup does not first re-create the directory it is removing', () => {
    const dir = path.join(base, 'sessions', 'svc', 'ana-1')
    const ender = makeEnder({
      base,
      cutter: { cancelWhere: () => 0 },
      remover: { remove: () => undefined }
    })
    ender.cleanup({ sessionId: 'svc-ana-1', workspaceId: 'ws-ana', serviceId: 'svc' })
    // A remove that had to mkdir the path first would be the sandboxRoot bug;
    // the pure builder must not touch disk.
    expect(existsSync(dir)).toBe(false)
  })
})
