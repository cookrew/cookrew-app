import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'

describe('auth origin startup isolation', () => {
  it('rejects overlapping configured authorities', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      for (const [origin, authOrigin] of [
        ['https://cookrew.dev', 'https://cookrew.dev'],
        ['https://COOKREW.DEV', 'https://cookrew.dev'],
        ['https://cookrew.dev:443', 'https://cookrew.dev'],
        ['https://cookrew.dev', 'https://cookrew.dev:443'],
        ['https://cookrew.dev.', 'https://cookrew.dev'],
        ['http://localhost', 'https://localhost'],
        ['http://localhost:80', 'https://localhost:443'],
        ['http://127.0.0.1:9876', 'http://127.0.0.1:9876']
      ]) {
        expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin, authOrigin }), `${origin} ${authOrigin}`).toThrow()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows distinct loopback ports', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin: 'http://127.0.0.1:9877', authOrigin: 'http://127.0.0.1:9876' })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    'https://auth.cookrew.dev',
    'https://AUTH.COOKREW.DEV',
    'https://auth.cookrew.dev.',
    'https://auth.cookrew.dev:443',
    'https://AUTH.COOKREW.DEV.:443'
  ])('rejects the reserved product origin %s when auth is unset', (origin) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin })).toThrow('Auth origin overlaps product origin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['https://auth.cookrew.dev:8443', 'https://auth.example'],
    ['http://auth.cookrew.dev:8790', 'http://127.0.0.1:9876'],
    ['https://AUTH.COOKREW.DEV.', 'https://auth.example'],
    ['https://auth.cookrew.dev', 'https://auth.example:8443'],
    ['https://auth.cookrew.dev:8443', undefined],
    ['http://auth.cookrew.dev:8790', undefined]
  ])('rejects reserved product hostname %s on any port with auth origin %s', (origin, authOrigin) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin, authOrigin })).toThrow('Auth origin overlaps product origin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['http://my_registry:8790', undefined],
    ['http://my_registry:8790', 'http://127.0.0.1:9876'],
    ['http://my_registry:8790', 'https://auth.example']
  ])('preserves URL-valid product origin %s with auth origin %s', (origin, authOrigin) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin, authOrigin })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([undefined, 'https://cookrew.dev', 'https://custom.example'])('allows product origin %s when auth is unset', (origin) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-startup-'))
    try {
      expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
