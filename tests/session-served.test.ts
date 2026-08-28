import { describe, expect, it, beforeEach } from 'vitest'
import {
  ServeRefused,
  ServedTemplates,
  resolveCallScope,
  serveRefusal,
  type ScopeLookup,
  type ServedTemplate,
  type TemplateDoor
} from '../src/main/session-served'

/**
 * THE INBOUND TRIGGER. An inbound slug names one of three things, and the
 * decision that tells them apart is where R30 begins: a live workspace is
 * answered as it always was, a served template mints, nothing is a 404.
 */

const crew = (over: Partial<ServedTemplate> = {}): ServedTemplate => ({
  serviceId: 'svc-research',
  templateId: 'research-crew',
  slug: 'research',
  access: 'account',
  ...over
})

/** Every template has an orch unless a test says otherwise. */
const hasOrch: TemplateDoor = { orchOf: () => 'Conductor' }
const noOrch: TemplateDoor = { orchOf: () => null }

describe('ServedTemplates — the registry', () => {
  let served: ServedTemplates
  beforeEach(() => {
    served = new ServedTemplates(hasOrch)
  })

  it('serves a template and finds it by slug and by service', () => {
    served.serve(crew())
    expect(served.bySlug('research')?.templateId).toBe('research-crew')
    expect(served.byService('svc-research')?.slug).toBe('research')
    expect(served.list()).toHaveLength(1)
  })

  it('stops serving and forgets both the service and its slug', () => {
    served.serve(crew())
    served.stop('svc-research')
    expect(served.bySlug('research')).toBeNull()
    expect(served.byService('svc-research')).toBeNull()
    expect(served.list()).toHaveLength(0)
  })

  it('re-serving a service under a new slug drops the stale slug', () => {
    served.serve(crew({ slug: 'research' }))
    served.serve(crew({ slug: 'lab' }))
    // The old slug must not still resolve, or a moved service answers at two
    // names, one of them stale.
    expect(served.bySlug('research')).toBeNull()
    expect(served.bySlug('lab')?.serviceId).toBe('svc-research')
    expect(served.list()).toHaveLength(1)
  })

  it('refuses a paid door without a price, and a price on a free door', () => {
    expect(() => served.serve(crew({ access: 'paid' }))).toThrow(/needs a price/)
    expect(() => served.serve(crew({ access: 'paid', priceUsd: '0' }))).toThrow(/needs a price/)
    expect(() => served.serve(crew({ access: 'paid', priceUsd: 'free' }))).toThrow(/needs a price/)
    expect(() => served.serve(crew({ access: 'account', priceUsd: '2.50' }))).toThrow(/cannot carry/)
    // The honest shapes both land.
    served.serve(crew({ access: 'paid', priceUsd: '2.50' }))
    expect(served.bySlug('research')?.priceUsd).toBe('2.50')
  })

  it('REFUSES a crew with no orch — the door a stranger would have got is a zsh prompt', () => {
    const shellTeam = new ServedTemplates(noOrch)
    expect(() => shellTeam.serve(crew())).toThrow(ServeRefused)
    expect(() => shellTeam.serve(crew())).toThrow(/needs an orch/)
    // And nothing is registered: a refused serve must not leave a half-open
    // door that resolves by slug.
    expect(shellTeam.bySlug('research')).toBeNull()
    expect(shellTeam.list()).toHaveLength(0)
  })

  it('carries the reason on the error, so a UI does not parse prose', () => {
    const shellTeam = new ServedTemplates(noOrch)
    try {
      shellTeam.serve(crew())
      expect.unreachable('serve should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ServeRefused)
      expect((error as ServeRefused).reason).toBe('no-orch')
    }
  })

  it('re-serving an orch-less crew cannot displace the entry that IS serving', () => {
    // The replace path deletes the prior slug before writing the new record;
    // refusing after that would leave the service unreachable at both names.
    served.serve(crew({ slug: 'research' }))
    const strict = new ServedTemplates({
      orchOf: (id) => (id === 'research-crew' ? 'Conductor' : null)
    })
    strict.serve(crew({ slug: 'research' }))
    expect(() => strict.serve(crew({ templateId: 'shell-only', slug: 'lab' }))).toThrow(
      /needs an orch/
    )
    expect(strict.bySlug('research')?.templateId).toBe('research-crew')
  })

  it('stopping something never served is a no-op', () => {
    expect(() => served.stop('svc-nobody')).not.toThrow()
    expect(served.list()).toHaveLength(0)
  })

  it('does not leak on the way IN — mutating the served input cannot corrupt it', () => {
    const input = crew()
    served.serve(input)
    input.slug = 'hacked'
    expect(served.bySlug('research')?.slug).toBe('research')
  })

  it('does not leak on the way OUT — a returned record is frozen', () => {
    served.serve(crew())
    const got = served.bySlug('research')!
    expect(Object.isFrozen(got)).toBe(true)
    // A mutation would desync serviceIdBySlug from templatesByService; strict
    // mode makes it throw rather than silently corrupt.
    expect(() => {
      ;(got as { slug: string }).slug = 'x'
    }).toThrow()
    expect(served.bySlug('research')?.slug).toBe('research')
  })
})

describe('serveRefusal — the same verdict, askable before the act', () => {
  it('is null for a crew that may be served', () => {
    expect(serveRefusal(crew(), hasOrch)).toBeNull()
    expect(serveRefusal(crew({ access: 'paid', priceUsd: '2.50' }), hasOrch)).toBeNull()
  })

  it('names no-orch, bad-price and priced-free-door', () => {
    expect(serveRefusal(crew(), noOrch)).toBe('no-orch')
    expect(serveRefusal(crew({ access: 'paid' }), hasOrch)).toBe('bad-price')
    expect(serveRefusal(crew({ access: 'account', priceUsd: '1' }), hasOrch)).toBe(
      'priced-free-door'
    )
  })

  it('reports the missing orch first when a crew is wrong twice over', () => {
    // A priced door is a crew configured wrong; an orch-less one cannot work at
    // all. Fixing the price on a crew that has no orch teaches nothing.
    expect(serveRefusal(crew({ access: 'paid' }), noOrch)).toBe('no-orch')
  })

  it('asks the door about THIS template, not some ambient current one', () => {
    const asked: string[] = []
    serveRefusal(crew({ templateId: 'research-crew' }), {
      orchOf: (id) => {
        asked.push(id)
        return 'Conductor'
      }
    })
    expect(asked).toEqual(['research-crew'])
  })
})

describe('resolveCallScope — three answers', () => {
  const lookup = (over: Partial<ScopeLookup>): ScopeLookup => ({
    liveWorkspaceId: () => null,
    servedBySlug: () => null,
    ...over
  })

  it('answers a live workspace as a workspace', () => {
    const scope = resolveCallScope('my-project', lookup({ liveWorkspaceId: () => 'ws-42' }))
    expect(scope).toEqual({ kind: 'workspace', workspaceId: 'ws-42' })
  })

  it('answers a served template as a serve (which will mint)', () => {
    const service = crew()
    const scope = resolveCallScope('research', lookup({ servedBySlug: () => service }))
    expect(scope).toEqual({ kind: 'serve', service })
  })

  it('answers an unknown slug as none — a 404, never a mint', () => {
    expect(resolveCallScope('nope', lookup({}))).toEqual({ kind: 'none' })
  })

  it('gives a live workspace PRECEDENCE over a served template on the same slug', () => {
    // Authoritative-wins: even if a service slug somehow collided with a
    // workspace the owner named, the caller lands on the owner's own, never a
    // stranger's mint.
    const scope = resolveCallScope(
      'research',
      lookup({ liveWorkspaceId: () => 'ws-owner', servedBySlug: () => crew() })
    )
    expect(scope).toEqual({ kind: 'workspace', workspaceId: 'ws-owner' })
  })
})
