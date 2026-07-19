import type http from 'node:http'

/** Small HTTP helpers shared by the mobile server's route modules. */

export function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  })
  response.end(JSON.stringify(body ?? null))
}

export function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) reject(new Error('Body too large'))
    })
    request.on('end', () => resolve(data))
    request.on('error', reject)
  })
}

export async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const raw = await readBody(request)
  return JSON.parse(raw || '{}') as T
}

export type SseSend = (event: string, data: unknown) => void

/**
 * Switch a response into a Server-Sent-Events stream. Returns the emitter;
 * register cleanup via `request.on('close', ...)` at the call site.
 */
export function startSse(response: http.ServerResponse): SseSend {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  })
  response.write(':ok\n\n')
  return (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}
