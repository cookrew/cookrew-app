import { describe, expect, it } from 'vitest'
import {
  matchesException,
  parseScutilProxy,
  readProxyConfig,
  tailnetProxyGaps,
  wouldBeProxied,
  type ProxyConfig
} from '../src/main/proxy-bypass'

/** Shape of a real `scutil --proxy` on a Mac running a local proxy app. */
const SCUTIL_WITH_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`

/** What the same command prints when nothing is configured. */
const SCUTIL_NO_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
}`

const proxied = (exceptions: string[]): ProxyConfig => ({ enabled: true, exceptions })

describe('parseScutilProxy', () => {
  it('reads the exception list and the enabled flags', () => {
    const config = parseScutilProxy(SCUTIL_WITH_PROXY)
    expect(config.enabled).toBe(true)
    expect(config.exceptions).toEqual([
      '127.0.0.1',
      '192.168.0.0/16',
      '10.0.0.0/8',
      '172.16.0.0/12',
      'localhost',
      '*.local',
      '<local>'
    ])
  })

  it('is not "enabled" when no proxy is switched on', () => {
    const config = parseScutilProxy(SCUTIL_NO_PROXY)
    expect(config.enabled).toBe(false)
    // The exceptions still parse — they just do not matter.
    expect(config.exceptions).toContain('*.local')
  })

  it('treats a SOCKS-only proxy as enabled — Chrome honours it too', () => {
    const config = parseScutilProxy('<dictionary> {\n  SOCKSEnable : 1\n}')
    expect(config.enabled).toBe(true)
  })

  it('survives output it cannot understand instead of throwing', () => {
    expect(parseScutilProxy('')).toEqual({ enabled: false, exceptions: [] })
    expect(parseScutilProxy('not a dictionary at all')).toEqual({ enabled: false, exceptions: [] })
  })
})

describe('matchesException', () => {
  it('matches a bare host, and names under it, but not a lookalike', () => {
    expect(matchesException('localhost', 'localhost')).toBe(true)
    expect(matchesException('db.localhost', 'localhost')).toBe(true)
    expect(matchesException('notlocalhost', 'localhost')).toBe(false)
    // `localhost` is the parent, not the child — this is a different host.
    expect(matchesException('localhost.example.com', 'localhost')).toBe(false)
  })

  it('matches a *.suffix entry against subdomains and the suffix itself', () => {
    expect(matchesException('workbench.tail1234.ts.net', '*.ts.net')).toBe(true)
    expect(matchesException('ts.net', '*.ts.net')).toBe(true)
    expect(matchesException('printer.local', '*.local')).toBe(true)
    expect(matchesException('example.com', '*.ts.net')).toBe(false)
    // A suffix must land on a dot boundary, or *.ts.net would swallow this.
    expect(matchesException('evilts.net', '*.ts.net')).toBe(false)
  })

  it('matches an address inside a CIDR entry', () => {
    expect(matchesException('192.168.2.13', '192.168.0.0/16')).toBe(true)
    expect(matchesException('10.7.7.7', '10.0.0.0/8')).toBe(true)
    expect(matchesException('172.20.1.1', '172.16.0.0/12')).toBe(true)
    expect(matchesException('172.32.1.1', '172.16.0.0/12')).toBe(false)
    expect(matchesException('100.101.102.103', '100.64.0.0/10')).toBe(true)
    // The /10 boundary is load-bearing: 100.0/8 is not Tailscale space.
    expect(matchesException('100.5.1.1', '100.64.0.0/10')).toBe(false)
  })

  it('accepts the abbreviated CIDR spelling macOS itself writes', () => {
    // Real exception lists contain `169.254/16` — the trailing zero octets
    // are implied. Rejecting that shape would mean nagging a user who is
    // already covered.
    expect(matchesException('169.254.1.1', '169.254/16')).toBe(true)
    expect(matchesException('100.101.102.103', '100.64/10')).toBe(true)
    expect(matchesException('10.7.7.7', '10/8')).toBe(true)
    expect(matchesException('11.7.7.7', '10/8')).toBe(false)
  })

  it('matches a bare IP entry exactly and not by prefix', () => {
    expect(matchesException('127.0.0.1', '127.0.0.1')).toBe(true)
    expect(matchesException('127.0.0.12', '127.0.0.1')).toBe(false)
  })

  it('matches <local> against dotless names only', () => {
    expect(matchesException('workbench', '<local>')).toBe(true)
    expect(matchesException('workbench.tail1234.ts.net', '<local>')).toBe(false)
  })

  it('ignores case and surrounding whitespace', () => {
    expect(matchesException('Workbench.Tail1234.TS.NET', ' *.ts.net ')).toBe(true)
  })
})

describe('wouldBeProxied', () => {
  it('is false when no proxy is configured at all', () => {
    expect(wouldBeProxied('workbench.tail1234.ts.net', null)).toBe(false)
    expect(wouldBeProxied('workbench.tail1234.ts.net', { enabled: false, exceptions: [] })).toBe(
      false
    )
  })

  it('is false when an exception covers the host', () => {
    expect(wouldBeProxied('192.168.2.13', proxied(['192.168.0.0/16']))).toBe(false)
    expect(wouldBeProxied('workbench.tail1234.ts.net', proxied(['*.ts.net']))).toBe(false)
  })

  it('is true when the proxy is on and nothing exempts the host', () => {
    const config = proxied(['127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', 'localhost', '*.local'])
    expect(wouldBeProxied('workbench.tail1234.ts.net', config)).toBe(true)
    expect(wouldBeProxied('100.101.102.103', config)).toBe(true)
  })
})

describe('tailnetProxyGaps', () => {
  const REAL_WORLD = proxied([
    '127.0.0.1',
    '192.168.0.0/16',
    '10.0.0.0/8',
    '172.16.0.0/12',
    'localhost',
    '*.local'
  ])

  it('names both missing entries when the proxy would swallow the tailnet', () => {
    const gaps = tailnetProxyGaps(['workbench.tail1234.ts.net', '100.101.102.103'], REAL_WORLD)
    expect(gaps).toEqual(['100.64.0.0/10', '*.ts.net'])
  })

  it('names only the entry the advertised hosts actually need', () => {
    expect(tailnetProxyGaps(['100.101.102.103'], REAL_WORLD)).toEqual(['100.64.0.0/10'])
    expect(tailnetProxyGaps(['workbench.tail1234.ts.net'], REAL_WORLD)).toEqual(['*.ts.net'])
  })

  it('is empty when the bypass entries are already present', () => {
    const covered = proxied([...REAL_WORLD.exceptions, '100.64.0.0/10', '*.ts.net'])
    expect(tailnetProxyGaps(['workbench.tail1234.ts.net', '100.101.102.103'], covered)).toEqual([])
  })

  it('is empty when there is no proxy', () => {
    expect(tailnetProxyGaps(['workbench.tail1234.ts.net', '100.101.102.103'], null)).toEqual([])
  })

  it('is empty when no tailnet host is advertised', () => {
    expect(tailnetProxyGaps([], REAL_WORLD)).toEqual([])
    // A LAN address is already exempt, and it is not a tailnet host anyway.
    expect(tailnetProxyGaps(['192.168.2.13'], REAL_WORLD)).toEqual([])
  })

  it('accepts an equivalent bypass spelling instead of demanding ours verbatim', () => {
    // Someone who typed 100.64/10 or *.tail1234.ts.net is already covered;
    // nagging them to add our exact string would be a false alarm.
    const alternative = proxied(['100.64.0.0/10', '*.tail1234.ts.net'])
    expect(tailnetProxyGaps(['workbench.tail1234.ts.net', '100.101.102.103'], alternative)).toEqual(
      []
    )
  })
})

describe('readProxyConfig', () => {
  it('returns the parsed config from the runner', () => {
    const config = readProxyConfig({ run: () => SCUTIL_WITH_PROXY })
    expect(config?.enabled).toBe(true)
    expect(config?.exceptions).toContain('*.local')
  })

  it('returns null instead of throwing when scutil is absent', () => {
    expect(
      readProxyConfig({
        run: () => {
          throw new Error('spawn scutil ENOENT')
        }
      })
    ).toBeNull()
  })
})
