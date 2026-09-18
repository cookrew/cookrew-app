import { afterEach, describe, expect, it } from 'vitest'
import { cookrewRegistry, parseAccountAddress, parseServeAddress } from '../src/main/import-session'
import { parseDeepLink } from '../src/main/deep-link'
import { registryOrigin } from '../src/main/registry-origin'

/**
 * THE REGISTRY IS A SETTING, AND A BARE NAME IS RESOLVED AT IT.
 *
 * `@handle/team` carries no origin, so something must supply one — and this
 * file used to supply a compile-time `https://cookrew.dev`. Everything else in
 * the app reads COOKREW_REGISTRY, so an app pointed at a local registry still
 * resolved published names at PRODUCTION: an isolated QA instance's lookup
 * left the machine, and a self-hosted deployment could not answer for its own
 * names. The same shape one file over had already posted invented passwords
 * at production, which is why this is pinned rather than remembered.
 *
 * The default is still production, because that is where the product's own
 * registry is — what changed is that it is a default and not a literal.
 */

const LOCAL = 'http://127.0.0.1:8799'
const held = process.env.COOKREW_REGISTRY

afterEach(() => {
  if (held === undefined) delete process.env.COOKREW_REGISTRY
  else process.env.COOKREW_REGISTRY = held
})

describe('a bare @handle/team is resolved at the CONFIGURED registry', () => {
  it('follows the configured origin, and does not reach production', () => {
    process.env.COOKREW_REGISTRY = LOCAL
    expect(registryOrigin()).toBe(LOCAL)
    expect(cookrewRegistry()).toBe(LOCAL)

    const target = parseServeAddress('@drej/alpha')
    expect(target).toEqual({ origin: LOCAL, slug: 'alpha', door: '@drej/alpha' })
    // The failure this replaces, named so a revert is unmistakable.
    expect(target?.origin).not.toBe('https://cookrew.dev')

    expect(parseAccountAddress('@drej')).toEqual({ origin: LOCAL, handle: 'drej' })
  })

  it('still answers production when nothing is configured', () => {
    delete process.env.COOKREW_REGISTRY
    expect(parseServeAddress('@drej/alpha')?.origin).toBe('https://cookrew.dev')
    expect(parseAccountAddress('@drej')?.origin).toBe('https://cookrew.dev')
  })

  it('reads a configured registry’s own page, and refuses production’s', () => {
    // The @-less form is only unambiguous on a registry we know — so which
    // registry we know has to be the one we are pointed at.
    process.env.COOKREW_REGISTRY = LOCAL
    expect(parseServeAddress(`${LOCAL}/drej/alpha`)).toEqual({
      origin: LOCAL,
      slug: 'alpha',
      door: '@drej/alpha'
    })
    expect(parseServeAddress('https://cookrew.dev/drej/alpha')).toBeNull()
    // A one-segment path on the registry is an owner, never a door — at
    // whichever registry is configured.
    expect(parseServeAddress(`${LOCAL}/drej`)).toBeNull()
  })

  it('a deep link from the configured registry’s page opens; production’s does not', () => {
    // A registry page link is https-ONLY, and that rule is not relaxed here:
    // what moved is WHICH https origin counts as the registry. (So a local
    // http registry has no deep links — noted, not worked around.)
    process.env.COOKREW_REGISTRY = 'https://registry.internal'
    expect(parseDeepLink('https://registry.internal/@drej/alpha')).toEqual({
      verb: 'import',
      address: '@drej/alpha'
    })
    expect(parseDeepLink('https://cookrew.dev/@drej/alpha')).toBeNull()
  })

  it('the cookrew:// scheme is unaffected — it names no origin at all', () => {
    process.env.COOKREW_REGISTRY = LOCAL
    expect(parseDeepLink('cookrew://import/@drej/alpha')).toEqual({
      verb: 'import',
      address: '@drej/alpha'
    })
  })

  it('an explicit origin is still honoured over the setting', () => {
    // The parsers take the registry so a caller can be explicit and a test
    // need not touch the environment at all.
    process.env.COOKREW_REGISTRY = LOCAL
    expect(parseServeAddress('@drej/alpha', 'https://elsewhere.example')?.origin).toBe(
      'https://elsewhere.example'
    )
  })

  it('a dialled door is unaffected — it carries its own address', () => {
    process.env.COOKREW_REGISTRY = LOCAL
    expect(parseServeAddress('192.168.1.20:8639/research-crew')).toEqual({
      origin: 'http://192.168.1.20:8639',
      slug: 'research-crew'
    })
  })
})
