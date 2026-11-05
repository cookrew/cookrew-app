// How a browser or note looks on a card, wherever the card is drawn: the
// desktop, the phone (zoom-layout.ts) and the watch (main/watch-cards.ts).

const TINTS = ['#6f8a5c', '#5d6b7a', '#7d6a9a', '#4f7f7a', '#a8692b', '#7a5c8a', '#8a6a4f']
export function tintOf(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]
}

/** A browser's host for its little address bar ("github.com/cookrew"); a bare word stays as it is. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return `file://${u.pathname.split('/').slice(-2, -1)[0] ?? ''}`
    return `${u.host}${u.pathname === '/' ? '' : u.pathname.split('/').slice(0, 2).join('/')}`
  } catch {
    return url
  }
}
