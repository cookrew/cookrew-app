// The levels stream over fetch instead of EventSource. EventSource hides the
// desktop's `:` keep-alives (so a stream gone silent — a hung relay leg —
// looks exactly like a quiet machine), cannot read a status, and cannot send
// a header (so the pairing token would ride in the URL). A fetch body read as
// text/event-stream does all three; the store still owns every retry.
import type { LevelsStream, StreamHandlers } from './fleet-store'

export interface SseSink {
  onData(data: string): void
  onComment(): void
}

/**
 * Feed text chunks in; whole events come out. Handles CRLF, multi-line
 * `data:`, a field without its space, and events split across chunks.
 */
export const createSseParser = (sink: SseSink) => {
  let buffer = ''
  let data: string[] = []
  const line = (raw: string) => {
    if (raw === '') {
      if (data.length > 0) sink.onData(data.join('\n'))
      data = []
      return
    }
    if (raw.startsWith(':')) return sink.onComment()
    const colon = raw.indexOf(':')
    const field = colon < 0 ? raw : raw.slice(0, colon)
    const value = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data = [...data, value]
  }
  return {
    push(chunk: string) {
      buffer += chunk
      const lines = buffer.split(/\r\n|\r|\n/)
      buffer = lines.pop() ?? ''
      for (const raw of lines) line(raw)
    }
  }
}

/** One stream; `onError` fires once, for a refusal, a drop or an end, never after close(). */
export const openFetchStream = (url: string, token: string | null, handlers: StreamHandlers): LevelsStream => {
  const abort = new AbortController()
  let closed = false
  const fail = () => {
    if (closed) return
    closed = true
    abort.abort()
    handlers.onError()
  }
  const parser = createSseParser({
    onData: (data) => {
      if (!closed) handlers.onMessage(data)
    },
    onComment: () => {
      if (!closed) handlers.onPing()
    }
  })
  fetch(url, {
    headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: abort.signal
  })
    .then(async (response) => {
      if (response.status !== 200 || !response.body) return fail()
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done || closed) break
        parser.push(value)
      }
      fail()
    })
    .catch(fail)
  return {
    close() {
      closed = true
      abort.abort()
    }
  }
}
