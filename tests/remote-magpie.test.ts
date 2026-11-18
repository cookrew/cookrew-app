import { describe, expect, it } from 'vitest'
import { privateHost } from '../src/shared/remote-magpie'
import { setupLineAllowed } from '../src/shared/route-lines'

describe('privateHost', () => {
  it('tell a private range, a tailnet and a LAN name from the open internet', () => {
    for (const host of ['10.0.0.2', '172.16.4.1', '192.168.1.20', '100.101.102.103', 'studio.local', 'mac.tail1234.ts.net']) expect(privateHost(host), host).toBe(true)
    for (const host of ['8.8.8.8', '172.32.0.1', 'gw.example.com', 'studio', '100.128.0.1']) expect(privateHost(host), host).toBe(false)
  })

})

describe('the Setup terminal no longer types a Remote magpie key line', () => {
  it('refuses every remote-magpie line, whatever its address: the key goes into Magpie’s own page', () => {
    for (const line of [
      'magpie provider add remote-magpie url=http://192.168.1.20:3425 id=office key=',
      'magpie provider add remote-magpie url=https://gw.example.com id=office key=',
      'magpie provider add remote-magpie url=http://127.0.0.1:13425 id=solis key='
    ]) {
      expect(setupLineAllowed(line), line).toBe(false)
    }
  })

  it('admits taking out a provider by id, and nothing that rides on it', () => {
    expect(setupLineAllowed('magpie provider rm solis')).toBe(true)
    expect(setupLineAllowed('magpie provider rm solis; id')).toBe(false)
    expect(setupLineAllowed('magpie provider rm -f solis')).toBe(false)
  })

  it('still admits a Claude or ChatGPT subscription sign-in through Magpie', () => {
    expect(setupLineAllowed('magpie accounts add claude')).toBe(true)
    expect(setupLineAllowed('magpie accounts add codex')).toBe(true)
  })
})
