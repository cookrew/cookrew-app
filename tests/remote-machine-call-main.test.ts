import { describe, expect, it } from 'vitest'
import { answerOf, callMachine, NO_ANSWER } from '../src/main/zoom-fleet'
import type { RemoteMachineCall } from '../src/shared/remote-machine-calls'

/**
 * ANOTHER MACHINE, WORKED FROM THIS ONE'S ZOOM VIEW (owner 2026-11-10, B): the
 * main half. One call, checked against the allow-list before anything leaves,
 * answered as its status and its JSON, or a picture as base64.
 */

const ID = '0f8c7b1e-1234-4abc-9def-0123456789ab'

const recorder = () => {
  const calls: { machineId: string; call: RemoteMachineCall; body: string | undefined }[] = []
  return {
    calls,
    deps: {
      callOf: async (machineId: string, call: RemoteMachineCall, body: string | undefined) => {
        calls.push({ machineId, call, body })
        return { status: 200, body: { ok: true } }
      }
    }
  }
}

describe('callMachine', () => {
  it('passes an allowed call, its body as JSON', async () => {
    const { calls, deps } = recorder()
    expect(await callMachine(deps, ID, 'POST', 'api/terminal/t-1/input', { text: 'hi' })).toEqual({ status: 200, body: { ok: true } })
    expect(calls).toEqual([{ machineId: ID, call: { method: 'POST', route: 'api/terminal/t-1/input', binary: false }, body: '{"text":"hi"}' }])
  })

  it('a read carries no body', async () => {
    const { calls, deps } = recorder()
    await callMachine(deps, ID, 'GET', 'api/watch/cards', { ignored: true })
    expect(calls[0]?.body).toBeUndefined()
  })

  it('refuses, sending nothing: a bad id, a call off the list, a body that is not an object or is too big', async () => {
    const { calls, deps } = recorder()
    for (const [id, method, route, body] of [
      ['not-an-id', 'GET', 'api/watch/cards', undefined],
      [ID, 'POST', 'api/terminal/t-1/raw', { text: 'rm -rf /' }],
      [ID, 'POST', 'api/terminal/t-1/input', 'text'],
      [ID, 'POST', 'api/terminal/t-1/input', ['a']],
      [ID, 'POST', 'api/terminal/t-1/input', { text: 'x'.repeat(70_000) }]
    ] as const) {
      expect(await callMachine(deps, id, method, route, body)).toEqual(NO_ANSWER)
    }
    expect(calls).toEqual([])
  })

  it('a machine with no way to call says nothing answered; a throw is the same', async () => {
    expect(await callMachine({}, ID, 'GET', 'api/watch/cards', undefined)).toEqual(NO_ANSWER)
    expect(
      await callMachine({ callOf: async () => { throw new Error('down') } }, ID, 'GET', 'api/watch/cards', undefined)
    ).toEqual(NO_ANSWER)
  })
})

describe('answerOf', () => {
  const json: RemoteMachineCall = { method: 'GET', route: 'api/watch/cards', binary: false }
  const picture: RemoteMachineCall = { method: 'GET', route: 'api/watch/item/b/frame?w=640', binary: true }

  it('JSON as its status and body; a body that is not JSON is null', async () => {
    expect(await answerOf(json, new Response('{"cards":[]}', { status: 200 }))).toEqual({ status: 200, body: { cards: [] } })
    expect(await answerOf(json, new Response('nope', { status: 502 }))).toEqual({ status: 502, body: null })
  })

  it('an answer past its size is no answer, and is not read whole', async () => {
    const big = new Response(new Uint8Array(5 * 1024 * 1024), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    expect(await answerOf(picture, big)).toEqual({ status: 200, body: null })
    const said = new Response('{}', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } })
    expect(await answerOf(json, said)).toEqual({ status: 200, body: null })
  })

  it('a picture as base64 with its type; only an image is one', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
    expect(await answerOf(picture, new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }))).toEqual({
      status: 200,
      picture: { type: 'image/jpeg', data: Buffer.from(bytes).toString('base64') }
    })
    expect(await answerOf(picture, new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))).toEqual({ status: 200, body: null })
    expect(await answerOf(picture, new Response('{"error":"No picture yet"}', { status: 404 }))).toEqual({ status: 404, body: { error: 'No picture yet' } })
  })
})
