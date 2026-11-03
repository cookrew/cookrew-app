import { describe, expect, it } from 'vitest'
import { createSseParser } from '../src/strata/fleet/sse-reader'

const collect = (chunks: string[]) => {
  const data: string[] = []
  let pings = 0
  const parser = createSseParser({ onData: (d) => data.push(d), onComment: () => (pings += 1) })
  for (const chunk of chunks) parser.push(chunk)
  return { data, pings }
}

describe('the levels stream parser', () => {
  it('reads events and keep-alives split anywhere across chunks', () => {
    const { data, pings } = collect(['data: {"a"', ':1}\n\n:\n', '\ndata:{"b":2}\r\n\r\n'])
    expect(data).toEqual(['{"a":1}', '{"b":2}'])
    expect(pings).toBe(1)
  })

  it('joins multi-line data and ignores other fields and a trailing partial event', () => {
    const { data } = collect(['event: x\nid: 3\ndata: one\ndata: two\n\ndata: half'])
    expect(data).toEqual(['one\ntwo'])
  })
})
