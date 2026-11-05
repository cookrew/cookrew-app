import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OAUTH_LOOPBACK_PATH } from '../shared/oauth'

/**
 * THE FALLBACK WAY BACK FROM THE BROWSER.
 *
 * `cookrew://` can fail quietly: in development the OS binds the scheme to a
 * bundle id every Electron copy shares, and a browser can simply refuse it. So
 * while a trip is in flight this listens on 127.0.0.1 and nowhere else, for one
 * path, and the registry's page offers it as a link.
 *
 * WHAT ARRIVES HERE IS NOT TRUSTED. It is handed to the caller, which drops it
 * unless the state is one it minted, and the handoff needs a verifier that
 * never left main. The Host check stops a page reaching this port through a
 * name it rebound to 127.0.0.1.
 */

export interface LoopbackListener {
  port: number
  close: () => void
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function answer(words: string): Buffer {
  return Buffer.from(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cookrew</title>` +
      `<style>body{font:15px -apple-system,sans-serif;margin:18vh auto;max-width:30em;text-align:center}</style>` +
      `</head><body><p>${words}</p></body></html>`,
    'utf8',
  )
}

/** Null when no port could be had: the scheme is then the only way back. */
export function listenForReturn(onReturn: (query: URLSearchParams) => boolean): Promise<LoopbackListener | null> {
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      const port = (server.address() as AddressInfo | null)?.port
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const ours =
        request.method === 'GET' && url.pathname === OAUTH_LOOPBACK_PATH && request.headers.host === `127.0.0.1:${port}`
      const accepted = ours && onReturn(url.searchParams)
      response.writeHead(accepted ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PAGE_CSP,
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      })
      response.end(answer(accepted ? 'Back in Cookrew. You can close this tab.' : 'This link is not for this sign-in.'))
    })
    server.once('error', () => resolve(null))
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          server.closeAllConnections()
          server.close()
        },
      })
    })
    server.unref()
  })
}
