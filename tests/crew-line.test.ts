import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MKT_GATE } from '../src/shared/marketplace-copy'

interface StubReply {
  status: number
  body: unknown
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function runCrewLine(
  input: string,
  replies: StubReply[],
  extraArgs: string[] = []
): Promise<{ stdout: string; askHeaders: http.IncomingHttpHeaders[] }> {
  const askHeaders: http.IncomingHttpHeaders[] = []
  const queued = [...replies]
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Drain request bodies so the real fetch client can reuse the socket.
      }
      const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
      let reply: StubReply
      if (pathname === '/research/api/call/challenge') {
        reply = { status: 200, body: { challenge: 'fixture-challenge' } }
      } else if (pathname === '/research/crew') {
        reply = { status: 200, body: { serviceId: 'svc-research' } }
      } else if (pathname === '/research/api/call/assert') {
        reply = { status: 200, body: { token: 'fixture-token' } }
      } else if (pathname === '/research/ask') {
        askHeaders.push(request.headers)
        reply = queued.shift() ?? { status: 200, body: { reply: 'ok' } }
      } else {
        reply = { status: 404, body: {} }
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.body))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const home = mkdtempSync(path.join(tmpdir(), 'crew-line-home-'))
  dirs.push(home)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'resources/crew-line.mjs'),
      '--origin',
      origin,
      '--slug',
      'research',
      '--sub',
      'fixture-caller',
      ...extraArgs
    ],
    { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin.end(input)

  const exit = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('crew-line fixture timed out'))
    }, 5_000)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  }).finally(() => new Promise<void>((resolve) => server.close(() => resolve())))

  if (exit !== 0) throw new Error(`crew-line exited ${exit}: ${stderr}`)
  return { stdout, askHeaders }
}

describe('crew-line payment voices and header lifetime', () => {
  it('does not auto-attach even a supplied stale --pay reference', async () => {
    const result = await runCrewLine(
      'hello\n',
      [{ status: 503, body: { reason: 'payment_unavailable' } }],
      ['--pay', 'stale-reference']
    )

    expect(result.askHeaders).toHaveLength(1)
    expect(result.askHeaders[0]['x-payment']).toBeUndefined()
    expect(result.stdout).toContain(MKT_GATE['mkt.gate.payment.unavailable'])
    expect(result.stdout).not.toContain('checker is unreachable')
  })

  it('sends X-Payment only after /pay and clears it after a successful ask', async () => {
    const result = await runCrewLine('/pay fresh-reference\nfirst\nsecond\n', [
      { status: 200, body: { reply: 'first answer' } },
      { status: 200, body: { reply: 'second answer' } }
    ])

    expect(result.askHeaders).toHaveLength(2)
    expect(result.askHeaders[0]['x-payment']).toBe('fresh-reference')
    expect(result.askHeaders[1]['x-payment']).toBeUndefined()
  })

  it('keeps the unverifiable voice for a payment that was actually sent', async () => {
    const result = await runCrewLine('/pay fresh-reference\nhello\n', [
      { status: 402, body: { reason: 'unverifiable', retryable: true } }
    ])

    expect(result.askHeaders[0]['x-payment']).toBe('fresh-reference')
    expect(result.stdout).toContain(MKT_GATE['mkt.gate.payment.unverifiable'])
    expect(result.stdout).not.toContain(MKT_GATE['mkt.gate.payment.unavailable'])
  })
})
