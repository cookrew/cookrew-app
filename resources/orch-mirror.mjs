#!/usr/bin/env node
// ORCH MIRROR — a proxy terminal that renders another agent's REAL terminal and
// forwards real keystrokes, over the SAME API the cookrew mobile companion uses.
// It streams the target's raw pty (a faithful ANSI frame + live deltas) so the
// proxy card looks exactly like a normal agent — the TUI, the composer, colors,
// cursor — not a flattened transcript.
//
//   node orch-mirror.mjs <terminalId> --origin https://host:port [--name label]
//
// Transport (mobile API, self-signed localhost cert):
//   READ   GET  <origin>/api/terminal/<id>/stream   (SSE: hello geometry, then
//                                                     data = raw ANSI bytes)
//   WRITE  POST <origin>/api/terminal/<id>/raw   {data}      (real keystrokes)
//   SIZE   POST <origin>/api/terminal/<id>/resize {cols,rows}
// Auth is the persisted pairing token; TLS trust is set in-process so the spawn
// command needs no env prefix (a pane may exec argv without a shell).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import https from 'node:https'

// TLS trust for the localhost self-signed cert is per-request via the Agent
// below (rejectUnauthorized:false) — NOT the global NODE_TLS_REJECT_UNAUTHORIZED
// env, which prints a warning that would land in the rendered terminal.

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : undefined
}
const id = process.argv[2]
const label = arg('--name') ?? id
if (!id) {
  console.error('orch-mirror: no terminal id')
  process.exit(1)
}
const ORIGIN = (arg('--origin') || process.env.COOKREW_MOBILE_ORIGIN || 'https://127.0.0.1:8643').replace(/\/+$/, '')
const base = new URL(ORIGIN)
const token = (() => {
  try {
    return readFileSync(path.join(homedir(), '.cookrew', 'pairing-token'), 'utf8').trim()
  } catch {
    return ''
  }
})()
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true })
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

// A POST with a JSON body, best-effort (a write that fails must not kill the
// mirror — the stream is the point).
function post(pathname, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = https.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/api/terminal/${encodeURIComponent(id)}/${pathname}`,
        method: 'POST',
        agent,
        headers: { ...authHeaders, 'content-type': 'application/json', 'content-length': data.length }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', () => resolve(0))
    req.write(data)
    req.end()
  })
}

const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30

// The SSE reader: connect, parse `event:/data:` blocks, write raw bytes to our
// own stdout. Reconnects on drop so a transient blip doesn't blank the card.
let closed = false
function connectStream() {
  const req = https.request(
    {
      hostname: base.hostname,
      port: base.port,
      path: `/api/terminal/${encodeURIComponent(id)}/stream`,
      method: 'GET',
      agent,
      // identity so we parse plain SSE, not gzip.
      headers: { ...authHeaders, accept: 'text/event-stream', 'accept-encoding': 'identity' }
    },
    (res) => {
      if (res.statusCode !== 200) {
        process.stdout.write(`\x1b[2m[mirror: stream ${res.statusCode} — retrying]\x1b[0m\r\n`)
        res.resume()
        return
      }
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (chunk) => {
        buf += chunk
        let sep
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          if (!block || block.startsWith(':')) continue // heartbeat/comment
          let event = 'message'
          let dataLine = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
          }
          if (!dataLine) continue
          let payload
          try {
            payload = JSON.parse(dataLine)
          } catch {
            continue
          }
          if (event === 'data') {
            process.stdout.write(payload) // faithful ANSI bytes → our xterm
          } else if (event === 'hello') {
            // Server announced ITS geometry; make sure it serializes at OURS.
            void post('resize', { cols: cols(), rows: rows() })
          } else if (event === 'exit') {
            process.stdout.write('\r\n\x1b[2m— the orch process exited —\x1b[0m\r\n')
          }
        }
      })
      res.on('end', () => scheduleReconnect())
      res.on('close', () => scheduleReconnect())
    }
  )
  req.on('error', () => scheduleReconnect())
  req.end()
}
function scheduleReconnect() {
  if (closed) return
  setTimeout(connectStream, 800)
}

// Real keystrokes: stdin in raw mode → POST /raw byte-for-byte, so the orch's
// TUI receives arrows, enter, ctrl keys — everything a normal card would send.
function wireInput() {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return // read-only fallback
  try {
    stdin.setRawMode(true)
  } catch {
    return
  }
  stdin.resume()
  stdin.setEncoding('utf8')
  stdin.on('data', (data) => {
    // Ctrl-] detaches the mirror without killing the orch.
    if (data === '\x1d') {
      cleanup()
      process.exit(0)
    }
    void post('raw', { data })
  })
}

const keepAlive = setInterval(() => {}, 1 << 30)
function cleanup() {
  closed = true
  clearInterval(keepAlive)
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    /* ignore */
  }
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.stdout.on('resize', () => void post('resize', { cols: cols(), rows: rows() }))

// Size first (so the first frame is serialized at our width), then stream.
process.stdout.write(`\x1b[2m── mirror → ${label} · ${ORIGIN}\x1b[0m\r\n`)
void post('resize', { cols: cols(), rows: rows() }).then(connectStream)
wireInput()
