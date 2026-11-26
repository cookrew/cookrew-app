import { describe, expect, it } from 'vitest'
import { remoteMachineCall } from '../src/shared/remote-machine-calls'

/**
 * WORKING IN ANOTHER MACHINE FROM THIS ONE'S ZOOM VIEW (owner 2026-11-10, B):
 * this machine relays to another of the account only the calls a card needs,
 * the watch's own (watch-routes.ts), never a shell or anything else.
 */

describe('the calls one machine may make on another', () => {
  it('reads its cards, whole or for one workspace', () => {
    expect(remoteMachineCall('GET', 'api/watch/cards')).toEqual({ method: 'GET', route: 'api/watch/cards', binary: false })
    expect(remoteMachineCall('GET', 'api/watch/cards?workspace=w-1')?.route).toBe('api/watch/cards?workspace=w-1')
  })

  it('reads them lean, as the zoom view draws them: tiles alone, or a crew with one card’s whole reply (bytes 0.6.2)', () => {
    for (const route of ['api/watch/cards?cards=0', 'api/watch/cards?workspace=w-1&full=none', 'api/watch/cards?workspace=w-1&full=t-1']) {
      expect(remoteMachineCall('GET', route)?.route, route).toBe(route)
    }
    for (const route of ['api/watch/cards?cards=1', 'api/watch/cards?full=none', 'api/watch/cards?workspace=w-1&full=', 'api/watch/cards?workspace=w-1&full=../x', 'api/watch/cards?cards=0&workspace=w-1']) {
      expect(remoteMachineCall('GET', route), route).toBeNull()
    }
  })

  it('answers, replies to and stops agents on it, from the card on the devices stop', () => {
    for (const route of ['api/terminal/abc-1/input', 'api/terminal/abc-1/menu', 'api/terminal/abc-1/seen', 'api/watch/card/abc-1/stop']) {
      expect(remoteMachineCall('POST', route), route).not.toBeNull()
    }
  })

  // Inside that machine its own app works it, as the console does (main/machine-guest.ts): what only
  // the old in-window stops asked (a new agent, an item's words and input, a screen's control) is gone.
  it('starts no agent, reads or touches no item, takes no screen: that is the machine’s own app now', () => {
    for (const [method, route] of [
      ['POST', 'api/watch/new'],
      ['POST', 'api/watch/new?seat=w-1'],
      ['POST', 'api/watch/item/b1/input'],
      ['GET', 'api/watch/item/n1'],
      ['POST', 'api/use/sources/control?seat=w-1'],
      ['POST', 'api/use/sources/unlock?seat=w-1']
    ] as const) {
      expect(remoteMachineCall(method, route), `${method} ${route}`).toBeNull()
    }
  })

  it('reads its pictures as bytes', () => {
    expect(remoteMachineCall('GET', 'api/watch/item/b1/frame?w=640')).toMatchObject({ binary: true })
    expect(remoteMachineCall('GET', 'api/watch/item/b1/frame?w=180&peek=1')).toMatchObject({ binary: true })
  })

  it('nothing else: no raw terminal input, no other route, no way out of the path, no other method', () => {
    for (const [method, route] of [
      ['POST', 'api/terminal/abc/raw'],
      ['POST', 'api/terminals'],
      ['GET', 'api/workspace'],
      ['GET', 'api/watch/cards/../../api/board'],
      ['GET', 'api/watch/item/..%2F..%2Fx/frame?w=1'],
      ['DELETE', 'api/watch/cards'],
      ['GET', 'api/watch/cards?workspace=w-1&x=../'],
      ['POST', 'api/watch/new?seat=../x'],
      ['POST', 'api/watch/code'],
      ['POST', 'api/watch/unpair'],
      ['GET', 'https://evil.example/api/watch/cards']
    ] as const) {
      expect(remoteMachineCall(method, route), `${method} ${route}`).toBeNull()
    }
  })
})

describe('what the zoom view asks another machine for (bytes 0.6.2)', () => {
  it('asks in the shapes the allow-list takes: tiles alone, a crew with no whole reply, or with the open card’s', async () => {
    const { cardsRoute } = await import('../src/renderer/src/zoom/use-remote-machine')
    expect(cardsRoute(null, null)).toBe('api/watch/cards?cards=0')
    expect(cardsRoute('w-1', null)).toBe('api/watch/cards?workspace=w-1&full=none')
    expect(cardsRoute('w-1', 't-9')).toBe('api/watch/cards?workspace=w-1&full=t-9')
    for (const route of [cardsRoute(null, null), cardsRoute('w-1', null), cardsRoute('w-1', 't-9')]) {
      expect(remoteMachineCall('GET', route)?.route, route).toBe(route)
    }
  })
})
