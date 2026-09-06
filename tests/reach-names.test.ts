import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAME_ZONE,
  addressFromLabel,
  coveredByWildcard,
  labelForAddress,
  trustedName,
  trustedOrigin,
  wildcardFor
} from '../src/shared/reach-names'

/**
 * PARITY WITH THE REGISTRY, CASE FOR CASE.
 *
 * These are the registry's own cases from tests/registry-dns-zone.test.ts
 * ("the label mapping, both ways"), restated against this Mac's copy. The two
 * halves live in different processes and cannot import each other; if they
 * ever disagree the Mac prints a URL the registry will not resolve, and the
 * failure looks like a broken product rather than a broken name.
 */
const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'

describe('the label mapping, both ways', () => {
  it('round trips every form a reach card can hold', () => {
    expect(labelForAddress('192.168.2.40')).toBe('192-168-2-40')
    expect(labelForAddress('fd7a:115c:a1e0::1234')).toBe('fd7a-115c-a1e0--1234')
    expect(labelForAddress('::1')).toBe('--1')
    expect(labelForAddress('mac.tail1234.ts.net')).toBeNull()
    for (const address of ['192.168.2.40', 'fd7a:115c:a1e0::1234', '::1', '100.101.102.103']) {
      const label = labelForAddress(address)
      expect(label).not.toBeNull()
      expect(addressFromLabel(label as string)).not.toBeNull()
    }
    expect(addressFromLabel('a--b--c')).toBeNull()
    expect(addressFromLabel('not-an-address')).toBeNull()
  })

  it('decodes a label back to the address it stands for', () => {
    expect(addressFromLabel('192-168-2-40')).toBe('192.168.2.40')
    expect(addressFromLabel('--1')).toBe('0:0:0:0:0:0:0:1')
    expect(addressFromLabel('fd7a-115c-a1e0--1234')).toBe('fd7a:115c:a1e0:0:0:0:0:1234')
  })

  it('refuses the shapes the registry refuses', () => {
    // Two `::` is not an address; an octet over 255 is not an octet.
    expect(addressFromLabel('1--2--3')).toBeNull()
    expect(labelForAddress('192.168.2.400')).toBeNull()
    expect(labelForAddress('')).toBeNull()
    // A bracketed literal is accepted and unbracketed, as parseIp does.
    expect(labelForAddress('[::1]')).toBe('--1')
  })

  it('takes a hostname for what it is: not an address', () => {
    for (const host of ['mac.local', 'cookrew.dev', 'localhost', '::ffff:192.168.1.1']) {
      expect(labelForAddress(host), host).toBeNull()
    }
  })
})

describe('the names this Mac asks a certificate for', () => {
  it('is one wildcard, under the device id', () => {
    expect(wildcardFor(MAC)).toBe(`*.${MAC}.${DEFAULT_NAME_ZONE}`)
    expect(wildcardFor(MAC, 'names.example.test')).toBe(`*.${MAC}.names.example.test`)
    expect(wildcardFor(MAC, 'd.cookrew.dev.')).toBe(`*.${MAC}.d.cookrew.dev`)
  })

  it('refuses a device id that could not be one label', () => {
    for (const id of ['', 'short', 'has.a.dot-in-it-and-is-long-enough', '-leading-dash-is-not-a-label']) {
      expect(wildcardFor(id), id).toBeNull()
    }
  })

  it('spells an origin a browser can be sent to', () => {
    expect(trustedName('192.168.2.40', MAC)).toBe(`192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)
    expect(trustedOrigin('192.168.2.40', MAC, DEFAULT_NAME_ZONE, 8643)).toBe(
      `https://192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}:8643`
    )
    // 443 is implicit in an origin; spelling it would not match the browser's.
    expect(trustedOrigin('192.168.2.40', MAC)).toBe(`https://192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)
    expect(trustedOrigin('mac.tail1234.ts.net', MAC, DEFAULT_NAME_ZONE, 8643)).toBeNull()
  })
})

describe('what the wildcard covers', () => {
  it('answers for one label and no more', () => {
    expect(coveredByWildcard(`192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`, MAC)).toBe(true)
    expect(coveredByWildcard(`ANY-LABEL.${MAC}.${DEFAULT_NAME_ZONE}`.toUpperCase(), MAC)).toBe(true)
    // RFC 6125: `*.a.b` does not cover `x.y.a.b`.
    expect(coveredByWildcard(`a.b.${MAC}.${DEFAULT_NAME_ZONE}`, MAC)).toBe(false)
    expect(coveredByWildcard(`${MAC}.${DEFAULT_NAME_ZONE}`, MAC)).toBe(false)
    // Another Mac's name, and a lookalike zone.
    expect(coveredByWildcard(`192-168-2-40.other-device-id-1234.${DEFAULT_NAME_ZONE}`, MAC)).toBe(false)
    expect(coveredByWildcard(`192-168-2-40.${MAC}.evil-d.cookrew.dev`, MAC)).toBe(false)
  })
})
