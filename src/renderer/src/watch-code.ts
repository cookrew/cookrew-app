/** Six digits for a watch, as the Mac mints them (main/watch-pairing.ts). */
export interface WatchCode {
  code: string
  expiresAt: number
  bases: { kind: string; url: string }[]
}

/** "482 193": two halves are what the eye carries to a wrist. */
export const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`

/** The address to type on the watch: its host and any port, no scheme. */
export function typedAddress(bases: WatchCode['bases']): string | null {
  const base = bases.find((one) => one.kind === 'lan') ?? bases.find((one) => one.kind === 'tailnet') ?? bases[0]
  if (!base) return null
  const url = new URL(base.url)
  return url.port === '8639' ? url.hostname : url.host
}

/** "4:59", the time a code has left; null once it has none. */
export function timeLeft(expiresAt: number, now: number): string | null {
  const seconds = Math.ceil((expiresAt - now) / 1000)
  if (seconds <= 0) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
