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

  it('answers, replies, stops and starts agents on it', () => {
    for (const route of ['api/terminal/abc-1/input', 'api/terminal/abc-1/menu', 'api/terminal/abc-1/seen', 'api/watch/card/abc-1/stop', 'api/watch/new', 'api/watch/new?seat=w-1', 'api/watch/item/b1/input']) {
      expect(remoteMachineCall('POST', route), route).not.toBeNull()
    }
  })

  it('takes and gives back control of a screen on it, in a workspace', () => {
    expect(remoteMachineCall('POST', 'api/use/sources/control?seat=w-1')).toMatchObject({ method: 'POST' })
    for (const route of ['api/use/sources/control', 'api/use/sources/unlock?seat=w-1', 'api/use/sources/open?seat=w-1', 'api/use/sources?seat=w-1']) {
      expect(remoteMachineCall('POST', route), route).toBeNull()
    }
  })

  it('reads its pictures as bytes, and its notes', () => {
    expect(remoteMachineCall('GET', 'api/watch/item/b1/frame?w=640')).toMatchObject({ binary: true })
    expect(remoteMachineCall('GET', 'api/watch/item/b1/frame?w=180&peek=1')).toMatchObject({ binary: true })
    expect(remoteMachineCall('GET', 'api/watch/item/n1')).toMatchObject({ binary: false })
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
