import { describe, expect, it } from 'vitest'
import { createRouteOrder, routeSnapshot } from '../src/renderer/src/routing/route-state-order'
import { ROUTE_HTTP_SCHEMA_VERSION, routeSchemaQuery } from '../src/shared/route'

describe('the schema a request claims', () => {
  it('reads decimal digits only', () => {
    expect(routeSchemaQuery('?route=2')).toBe(2)
    expect(routeSchemaQuery('?boot=x&route=2&seat=w')).toBe(2)
    for (const loose of ['', '?route=', '?route=0x2', '?route=%202%20', '?route=2.0']) expect(routeSchemaQuery(loose)).toBeNull()
  })
})
import { routeFixture } from '../src/shared/route-fixture'
import { accountStarting, accountVia } from '../src/shared/ai-account'
import { routeChoices } from '../src/shared/route-view'

/**
 * A read issued before a push or a pick landed is older than them whatever
 * it says, and is dropped; a read nothing overtook is applied.
 */
describe('route state at the shared consumer boundary', () => {
  it('accepts both legacy and current snapshots', () => {
    const legacy = routeFixture()
    expect(routeSnapshot(legacy)).toEqual({ state: legacy, incompatible: false })
    const current = { ...legacy, schemaVersion: ROUTE_HTTP_SCHEMA_VERSION }
    expect(routeSnapshot(current)).toEqual({ state: current, incompatible: false })
  })

  it.each([
    { schemaVersion: ROUTE_HTTP_SCHEMA_VERSION + 1 },
    { schemaVersion: ROUTE_HTTP_SCHEMA_VERSION + 1, status: 'online', models: 'changed' },
    { schemaVersion: 'future', status: 'online' },
    null
  ])('withholds an incompatible payload before first-run and prompt consumers', (payload) => {
    const snapshot = routeSnapshot(payload)
    expect(snapshot).toEqual({ state: null, incompatible: true })
    expect(accountStarting(snapshot.state)).toBe(false)
    expect(accountVia({ route: snapshot.state, endpoint: false })).toBeNull()
    const route = snapshot.state
    expect(route?.status === 'online' ? routeChoices(route.models) : []).toEqual([])
  })
})

describe('which route state is the newest', () => {
  it('applies a read nothing overtook', () => {
    const order = createRouteOrder()
    const issued = order.issue()
    expect(order.stillNewest(issued)).toBe(true)
  })

  it('drops a read that a push overtook', () => {
    const order = createRouteOrder()
    const issued = order.issue()
    order.applied() // a push, or the answer to the owner's pick
    expect(order.stillNewest(issued)).toBe(false)
  })

  it('lets the next read through once it is issued after the push', () => {
    const order = createRouteOrder()
    const stale = order.issue()
    order.applied()
    const fresh = order.issue()
    expect(order.stillNewest(stale)).toBe(false)
    expect(order.stillNewest(fresh)).toBe(true)
    order.applied()
    expect(order.stillNewest(fresh)).toBe(false)
  })
})
