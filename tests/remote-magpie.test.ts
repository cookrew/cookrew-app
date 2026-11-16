import { describe, expect, it } from 'vitest'
import { checkRemoteMagpie, remoteMagpieLine } from '../src/shared/remote-magpie'
import { setupAskAllowed, setupLineAllowed } from '../src/shared/route-lines'

const ok = (address: string, name = 'Mac') => {
  const answer = checkRemoteMagpie({ address, name })
  if (!answer.ok) throw new Error(`refused ${address}: ${answer.why}`)
  return answer
}

describe('checkRemoteMagpie', () => {
  it('takes a bare LAN address and gives it http and Magpie’s port', () => {
    expect(ok('192.168.1.20').url).toBe('http://192.168.1.20:3425')
    expect(ok('10.0.0.7:4000').url).toBe('http://10.0.0.7:4000')
  })

  it('keeps a typed scheme and port', () => {
    expect(ok('https://gw.example.com').url).toBe('https://gw.example.com')
    expect(ok('https://mac.tail1234.ts.net:3425/').url).toBe('https://mac.tail1234.ts.net:3425')
  })

  it('lets plain http cross only a private network or a tailnet', () => {
    expect(ok('http://100.101.102.103:3425').url).toBe('http://100.101.102.103:3425')
    expect(ok('mac.tail1234.ts.net').url).toBe('http://mac.tail1234.ts.net:3425')
    expect(ok('studio.local').url).toBe('http://studio.local:3425')
    const open = checkRemoteMagpie({ address: 'http://gw.example.com:3425', name: 'x' })
    expect(open).toMatchObject({ ok: false, field: 'address' })
  })

  it('does not trust a bare one-word name with plain http', () => {
    expect(ok('studio').url).toBe('https://studio:3425')
    expect(checkRemoteMagpie({ address: 'http://office:3425', name: 'x' })).toMatchObject({ ok: false, field: 'address' })
  })

  it('keeps a typed port even when it is the scheme’s default', () => {
    expect(ok('10.0.0.5:80').url).toBe('http://10.0.0.5:80')
  })

  it('takes a tunnel on this computer’s loopback, on any port but Magpie’s own', () => {
    expect(ok('127.0.0.1:13425').url).toBe('http://127.0.0.1:13425')
    expect(ok('localhost:13425').url).toBe('http://127.0.0.1:13425')
    expect(setupLineAllowed(ok('127.0.0.1:13425', 'solis').line)).toBe(true)
  })

  it('reads every spelling of this computer’s own Magpie as this computer', () => {
    for (const address of ['2130706433', '0177.0.0.1', 'http://127.1:3425', '0.0.0.0', '127.0.0.1', 'localhost:3425']) {
      expect(checkRemoteMagpie({ address, name: 'x' })).toMatchObject({ ok: false, field: 'address' })
    }
  })

  it('reads a public name without a scheme as https', () => {
    expect(ok('gw.example.com').url).toBe('https://gw.example.com:3425')
  })

  it('refuses this computer, credentials, paths, queries and IPv6 literals', () => {
    for (const address of ['127.0.0.1:3425', 'localhost:3425', 'http://user:pw@10.0.0.2', 'http://10.0.0.2/v1', 'http://10.0.0.2?x=1', 'http://[fd00::1]:3425', '', 'ftp://10.0.0.2', '10.0.0.2;id', '10.0.0.2 $(id)']) {
      expect(checkRemoteMagpie({ address, name: 'x' })).toMatchObject({ ok: false, field: 'address' })
    }
  })

  it('makes a provider id from the name, and refuses one that names a vendor', () => {
    expect(ok('10.0.0.2', 'Drej’s Mac Studio').id).toBe('drej-s-mac-studio')
    expect(ok('10.0.0.2', '').id).toBe('remote')
    expect(ok('10.0.0.2', '    ').id).toBe('remote')
    expect(ok('10.0.0.2', 'a'.repeat(60)).id).toHaveLength(24)
    expect(checkRemoteMagpie({ address: '10.0.0.2', name: 'Claude' })).toMatchObject({ ok: false, field: 'name' })
  })

  it('doubts what arrives over a bridge', () => {
    expect(checkRemoteMagpie(null)).toMatchObject({ ok: false, field: 'address' })
    expect(checkRemoteMagpie({ address: 7 })).toMatchObject({ ok: false, field: 'address' })
  })

  it('ends the line at key= so the person pastes the key into the terminal', () => {
    const answer = ok('192.168.1.20', 'office')
    expect(answer.line).toBe('magpie provider add remote-magpie url=http://192.168.1.20:3425 id=office key=')
    expect(remoteMagpieLine(answer.url, answer.id)).toBe(answer.line)
  })
})

describe('the remote-magpie line in the Setup allowlist', () => {
  it('admits the lines checkRemoteMagpie makes', () => {
    for (const address of ['192.168.1.20', 'https://gw.example.com', 'mac.tail1234.ts.net:4000']) {
      expect(setupLineAllowed(ok(address, 'Office Mac').line)).toBe(true)
    }
  })

  it('refuses any other shape of it', () => {
    for (const line of [
      'magpie provider add remote-magpie url=http://10.0.0.2:3425 id=office key=sk-magpie-abc',
      'magpie provider add remote-magpie url=http://10.0.0.2:3425 id=office key= ;id',
      'magpie provider add remote-magpie url=http://10.0.0.2:3425/$(id) id=office key=',
      'magpie provider add remote-magpie url=http://[::1]:3425 id=office key=',
      'magpie provider add remote-magpie url=http://10.0.0.2:3425 id=Office key=',
      'magpie provider add remote-magpie url=file:///etc id=office key='
    ]) {
      expect(setupLineAllowed(line)).toBe(false)
    }
  })

  it('refuses a line of the right shape whose address the form would refuse', () => {
    expect(setupLineAllowed('magpie provider add remote-magpie url=http://attacker.example id=office key=')).toBe(false)
    expect(setupLineAllowed('magpie provider add remote-magpie url=http://127.0.0.1:3425 id=office key=')).toBe(false)
    expect(setupLineAllowed('magpie provider add remote-magpie url=http://localhost:13425 id=office key=')).toBe(false)
    expect(setupLineAllowed('magpie provider add remote-magpie url=https://attacker.example id=office key=')).toBe(true)
  })

  it('lets a key line run only without Enter, so an empty key is never saved', () => {
    const line = ok('192.168.1.20', 'office').line
    expect(setupAskAllowed(line, false)).toBe(true)
    expect(setupAskAllowed(line, true)).toBe(false)
    expect(setupAskAllowed('magpie provider add deepseek ', true)).toBe(false)
    expect(setupAskAllowed('magpie provider add deepseek ', false)).toBe(true)
    expect(setupAskAllowed('magpie accounts add claude', true)).toBe(true)
  })

  it('admits a Claude subscription sign-in through Magpie as well as ChatGPT', () => {
    expect(setupLineAllowed('magpie accounts add claude')).toBe(true)
    expect(setupLineAllowed('magpie accounts add codex')).toBe(true)
    expect(setupLineAllowed('magpie accounts add claude --yes')).toBe(false)
  })
})
