// WHO MAY USE THE FORWARDER (magpie-remote/caller.ts): the pid at the client end of a
// loopback connection, read from lsof or ss, and nothing when that cannot be read.
import { describe, expect, it } from 'vitest'
import { callerIsMagpie, parseLsofPids, parseSsPids } from '../src/main/magpie-remote/caller'

describe('caller pids', () => {
  it('reads lsof -Fp output', () => {
    expect(parseLsofPids('p123\nf7\np456\nf9\np123\n')).toEqual([123, 456])
    expect(parseLsofPids('')).toEqual([])
  })

  it('reads the owner of a socket whose local address is the client port, and nothing else', () => {
    const line = 'ESTAB 0 0 127.0.0.1:52344 127.0.0.1:3428 users:(("magpie",pid=4242,fd=12))'
    const other = 'ESTAB 0 0 127.0.0.1:3428 127.0.0.1:52344 users:(("cookrew",pid=1,fd=40))'
    expect(parseSsPids(`${line}\n${other}`, 52344)).toEqual([4242])
    expect(parseSsPids(other, 52344)).toEqual([])
  })

  it('refuses when there is no magpie to compare with', async () => {
    expect(await callerIsMagpie(1, null)).toBe(false)
    expect(await callerIsMagpie(1, '/no/such/magpie')).toBe(false)
  })
})
