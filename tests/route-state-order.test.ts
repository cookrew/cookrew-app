import { describe, expect, it } from 'vitest'
import { createRouteOrder } from '../src/renderer/src/routing/route-state-order'

/**
 * A read issued before a push or a pick landed is older than them whatever
 * it says, and is dropped; a read nothing overtook is applied.
 */
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
