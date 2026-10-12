// THE CONFIG READER: the plugin file per call, null until it is whole, and
// the key order route.key → sous-gateway.key → magpie-sous.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOUS_GATEWAY_KEY_FALLBACK, SOUS_ROUTE_FILE, sousGatewayKey, sousRouteConfig } from '../src/main/sous-config'

const base = () => mkdtempSync(path.join(tmpdir(), 'cookrew-sous-route-'))
const whole = {
  'route.gateway': 'http://127.0.0.1:3425',
  'route.v1': 'http://127.0.0.1:3425/v1',
  'route.key': 'sk-magpie-key-SOUS',
  'route.model': 'group/jevs'
}

describe('sousRouteConfig', () => {
  it('is null with no file, an unreadable file, or a file that is not an object', () => {
    const dir = base()
    expect(sousRouteConfig(dir)).toBeNull()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), '{not json')
    expect(sousRouteConfig(dir)).toBeNull()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), '[1,2]')
    expect(sousRouteConfig(dir)).toBeNull()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), 'null')
    expect(sousRouteConfig(dir)).toBeNull()
  })

  it('is null until all four route.* keys are present and non-empty', () => {
    const dir = base()
    for (const missing of Object.keys(whole)) {
      const partial: Record<string, unknown> = { ...whole }
      delete partial[missing]
      writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify(partial))
      expect(sousRouteConfig(dir), `without ${missing}`).toBeNull()
      writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify({ ...whole, [missing]: '  ' }))
      expect(sousRouteConfig(dir), `blank ${missing}`).toBeNull()
    }
  })

  it('reads the four keys, trimmed, and ignores everything else', () => {
    const dir = base()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify({ ...whole, 'route.model': ' group/jevs ', extra: 'x' }))
    expect(sousRouteConfig(dir)).toEqual({ gateway: whole['route.gateway'], v1: whole['route.v1'], key: whole['route.key'], model: 'group/jevs' })
  })

  it('is read per call: a file that disappears is null on the next call', () => {
    const dir = base()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify(whole))
    expect(sousRouteConfig(dir)).not.toBeNull()
    rmSync(path.join(dir, SOUS_ROUTE_FILE))
    expect(sousRouteConfig(dir)).toBeNull()
  })
})

describe('sousGatewayKey', () => {
  it('route.key from the plugin file wins', () => {
    const dir = base()
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify(whole))
    writeFileSync(path.join(dir, 'sous-gateway.key'), 'sk-magpie-key-SCRIPT\n')
    expect(sousGatewayKey(dir)).toBe('sk-magpie-key-SOUS')
  })
  it('then the scoped key file the script minted', () => {
    const dir = base()
    writeFileSync(path.join(dir, 'sous-gateway.key'), 'sk-magpie-key-SCRIPT\n')
    expect(sousGatewayKey(dir)).toBe('sk-magpie-key-SCRIPT')
    // A partial plugin file does not outrank it.
    writeFileSync(path.join(dir, SOUS_ROUTE_FILE), JSON.stringify({ 'route.key': 'sk-magpie-key-HALF' }))
    expect(sousGatewayKey(dir)).toBe('sk-magpie-key-SCRIPT')
  })
  it('then the local magpie-sous token', () => {
    const dir = base()
    expect(sousGatewayKey(dir)).toBe(SOUS_GATEWAY_KEY_FALLBACK)
    writeFileSync(path.join(dir, 'sous-gateway.key'), '\n')
    expect(sousGatewayKey(dir)).toBe(SOUS_GATEWAY_KEY_FALLBACK)
  })
})
