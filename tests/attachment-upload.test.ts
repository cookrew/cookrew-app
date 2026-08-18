import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readBody, readBytes } from '../src/main/mobile-http'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { MAX_ATTACHMENT_BYTES, saveAttachment } from '../src/main/attachments'

/**
 * Uploads used to travel as base64 inside JSON. Two costs, both paid on the
 * link where they hurt most:
 *
 *   wire   +33%, on a relayed tailnet where bytes are the scarce thing
 *   main   a 20 MB photo became a 27 MB string, concatenated chunk by chunk
 *          and then JSON.parse'd — on the Electron MAIN process, so the whole
 *          desktop froze for the length of every upload
 *
 * Raw bytes with the name in the query have neither.
 */

const TOKEN = 'pairing-token-123'

function stubDeps(dir: string): MobileApiDeps {
  return {
    pairingToken: TOKEN,
    saveAttachment: (name: string, data: Buffer) => saveAttachment(dir, name, data)
  } as unknown as MobileApiDeps
}

describe('readBytes', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const echo = async (
    handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
  ): Promise<number> => {
    const server = http.createServer(handler)
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  it('returns the exact bytes, binary intact', async () => {
    // Every byte value, including the ones no UTF-8 decoder survives — the
    // old string path corrupted these silently.
    const payload = Buffer.from(Array.from({ length: 256 }, (_, at) => at))
    let seen: Buffer | null = null
    const port = await echo(async (request, response) => {
      seen = await readBytes(request, MAX_ATTACHMENT_BYTES)
      response.end('ok')
    })
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: payload })
    expect(seen).not.toBeNull()
    expect(Buffer.compare(seen!, payload)).toBe(0)
  })

  it('refuses a body over the cap instead of buffering it all', async () => {
    let rejected: Error | null = null
    const port = await echo(async (request, response) => {
      rejected = await readBytes(request, 64).then(
        () => null,
        (error: Error) => error
      )
      response.end('done')
    })
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: Buffer.alloc(4096, 1)
    }).catch(() => undefined)
    for (let attempt = 0; attempt < 100 && !rejected; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as unknown as Error).message).toMatch(/too large/i)
  })

  it('readBody stops the stream when it gives up, rather than growing on', async () => {
    // Rejecting alone left the request filling a string that was already over
    // the limit — the caller had walked away and the memory kept climbing.
    let destroyed = false
    const port = await echo(async (request, response) => {
      await readBody(request, 32).catch(() => undefined)
      destroyed = request.destroyed
      response.end('done')
    })
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(8192) }).catch(
      () => undefined
    )
    for (let attempt = 0; attempt < 100 && !destroyed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(destroyed).toBe(true)
  })
})

describe('POST /api/attachments', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (): Promise<{ port: number; dir: string }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-upload-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const deps = stubDeps(dir)
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, dir }
  }

  it('accepts raw bytes with the name in the query', async () => {
    const { port, dir } = await startApi()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments?name=shot.png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream'
      },
      body: bytes
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { path: string }
    expect(path.dirname(saved.path)).toBe(dir)
    expect(path.basename(saved.path)).toBe('shot.png')
    // Binary must survive verbatim — a PNG header through a text path does not.
    expect(Buffer.compare(readFileSync(saved.path), bytes)).toBe(0)
  })

  it('still accepts the base64 JSON shape a cached older bundle sends', async () => {
    // Dropping it would break uploads on every phone until it reloaded.
    const { port } = await startApi()
    const bytes = Buffer.from('hello attachment')
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'note.txt', data: bytes.toString('base64') })
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { path: string }
    expect(readFileSync(saved.path, 'utf8')).toBe('hello attachment')
  })

  it('refuses an empty upload rather than writing a zero-byte file', async () => {
    const { port } = await startApi()
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments?name=empty.bin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0)
    })
    expect(response.status).toBe(400)
  })

  it('names an unnamed upload rather than failing it', async () => {
    const { port } = await startApi()
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from('bytes with no name')
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { path: string }
    expect(path.basename(saved.path)).toMatch(/^file/)
  })

  it('still requires the pairing token', async () => {
    // The raw shape is a new entry point into a mutating route on a 0.0.0.0
    // listener; it must sit behind the same gate as every other one.
    const { port } = await startApi()
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments?name=x.bin`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('should not land')
    })
    expect(response.status).toBe(401)
  })

  it('does not let a crafted name escape the attachments directory', async () => {
    const { port, dir } = await startApi()
    const response = await fetch(
      `http://127.0.0.1:${port}/api/attachments?name=${encodeURIComponent('../../escaped.sh')}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
        body: Buffer.from('payload')
      }
    )
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { path: string }
    expect(path.dirname(saved.path)).toBe(dir)
  })
})
