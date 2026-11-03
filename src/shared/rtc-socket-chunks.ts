/**
 * ONE WEBSOCKET MESSAGE AS SEVERAL DATA-CHANNEL MESSAGES.
 *
 * A browser-card frame is a JSON line with a whole JPEG in it — hundreds of
 * KB — and a data channel message past the peer's limit throws (Safari's sits
 * far below that). So a socket carried on the WebRTC link (main/rtc-peer.ts,
 * renderer path/rtc-link.ts) sends each message as pieces of at most
 * RTC_SOCKET_PIECE characters, each led by one mark: `+` when more follows,
 * `=` on the last. The channel is ordered and reliable, so joining is
 * concatenation.
 */

export const RTC_SOCKET_LABEL = 'cookrew-ws'
export const RTC_SOCKET_PIECE = 16 * 1024
/** A message past this is refused rather than buffered: nothing honest is this large. */
export const RTC_SOCKET_MESSAGE_MAX = 16 * 1024 * 1024

const MORE = '+'
const LAST = '='

/** The channel label for a socket at `path` (a Mac path, `/api/...`). */
export const socketLabel = (path: string): string => `${RTC_SOCKET_LABEL} ${path}`

/** The path a socket label names, or null for any other channel. */
export const socketPathOf = (label: string): string | null =>
  label.startsWith(`${RTC_SOCKET_LABEL} /`) ? label.slice(RTC_SOCKET_LABEL.length + 1) : null

/** The pieces for one message, never cutting a surrogate pair in two. */
export const splitMessage = (text: string, piece: number = RTC_SOCKET_PIECE): string[] => {
  if (text.length <= piece) return [`${LAST}${text}`]
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(at + piece, text.length)
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    out.push(`${end >= text.length ? LAST : MORE}${text.slice(at, end)}`)
    at = end
  }
  return out
}

/** Feed pieces in order; `onMessage` hears each whole message once. False when a piece is refused. */
export const createJoiner = (onMessage: (text: string) => void, max: number = RTC_SOCKET_MESSAGE_MAX) => {
  let parts: string[] = []
  let size = 0
  return (piece: string): boolean => {
    const mark = piece.charAt(0)
    if (mark !== MORE && mark !== LAST) return false
    const body = piece.slice(1)
    size += body.length
    if (size > max) {
      parts = []
      size = 0
      return false
    }
    parts.push(body)
    if (mark === MORE) return true
    const whole = parts.join('')
    parts = []
    size = 0
    onMessage(whole)
    return true
  }
}
