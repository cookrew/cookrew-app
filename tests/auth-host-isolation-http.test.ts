import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'

describe('auth host isolation HTTP', () => {
  async function withServer(authOrigin: string | undefined, run: (server: Server) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-host-'))
    const server = createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin: 'https://cookrew.dev', authOrigin, relay: true })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      await run(server)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function status(server: Server, host: string, pathname: string, method = 'GET'): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const outgoing = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: pathname, method, headers: { host } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
  }

  it('protects canonical auth host with unset and custom origins while preserving product routing', async () => {
    await withServer(undefined, async (server) => {
      for (const host of ['auth.cookrew.dev', 'AUTH.COOKREW.DEV.', 'auth.cookrew.dev.:443', 'auth.cookrew.dev:443']) {
        expect(await status(server, host, '/v1/health'), host).toBe(404)
      }
      expect(await status(server, 'cookrew.dev', '/v1/health')).toBe(200)
    })
    await withServer('http://127.0.0.1:9876', async (server) => {
      expect(await status(server, 'auth.cookrew.dev.', '/v1/health')).toBe(404)
      expect(await status(server, '127.0.0.1:9876', '/v1/health')).toBe(404)
      expect(await status(server, 'cookrew.dev', '/v1/health')).toBe(200)
    })
    await withServer('https://auth.cookrew.dev', async (server) => {
      expect(await status(server, 'cookrew.dev', '/v1/health')).toBe(200)
      expect(await status(server, 'auth.cookrew.dev.evil.test', '/v1/health')).toBe(200)
    })
  })

  it('serves underscore product hosts while auth host variants and malformed authorities stay denied', async () => {
    for (const authOrigin of [undefined, 'http://127.0.0.1:9876', 'https://auth.cookrew.dev']) {
      await withServer(authOrigin, async (server) => {
        expect(await status(server, 'my_registry:8790', '/v1/health'), `${authOrigin} my_registry:8790`).toBe(200)
        expect(await status(server, 'my_registry', '/v1/health'), `${authOrigin} my_registry`).toBe(200)
        for (const host of ['my_registry:', 'my_registry:08790', 'my_registry:8790:8790', 'my_registry@evil.test', '_registry', 'auth.cookrew.dev:8790', 'auth.cookrew.dev.:8790', 'auth.cookrew.dev:80', 'auth.cookrew.dev.']) {
          expect(await status(server, host, '/v1/health'), `${authOrigin} ${host}`).toBe(404)
        }
      })
    }
  })

  it('denies every auth-host route before relay and identity routing', async () => {
    await withServer('https://auth.cookrew.dev', async (server) => {
      for (const host of ['auth.cookrew.dev', 'auth.cookrew.dev:443', 'AUTH.COOKREW.DEV.', 'auth.cookrew.dev.:443']) {
        for (const pathname of ['/v1/health', '/v1/relay', '/v2/canvas', '/v2/oauth/providers', '/market', '/', '/sign-in', '/assets/auth-site.js']) {
          expect(await status(server, host, pathname), `${host} ${pathname}`).toBe(404)
        }
        expect(await status(server, host, '/v2/sessions', 'POST')).toBe(404)
      }
      expect(await status(server, 'auth.cookrew.dev@evil.test', '/v1/health')).toBe(404)
      expect(await status(server, 'auth.cookrew.dev:', '/v1/health')).toBe(404)
      expect(await status(server, 'auth.cookrew.dev:0443', '/v1/health')).toBe(404)
      expect(await status(server, 'auth.cookrew.dev:443:443', '/v1/health')).toBe(404)
    })
  })

  it('rejects invalid configured origins at startup', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-host-'))
    try {
      for (const authOrigin of ['', 'not a url', 'http://auth.cookrew.dev', 'https://auth.cookrew.dev/path', 'https://user@auth.cookrew.dev', 'https://auth.cookrew.dev/unexpected/..', 'https://auth.cookrew.dev?', 'https://auth.cookrew.dev#', 'https://auth.cookrew.dev:0443']) {
        expect(() => createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), authOrigin }), authOrigin).toThrow('Invalid auth origin configuration')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
