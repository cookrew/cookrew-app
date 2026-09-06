/* cookrew.dev — THE DESKTOPS ROW (reach v2.1): is this Mac holding its line?
 *
 * The server sent every state this row can be in. This script does one thing:
 * it asks cookrew.dev whether each Mac is holding its relay line, and unhides
 * ONLINE or OFFLINE accordingly. PROBING is what the server ships, so a reader
 * meets an honest "asking" rather than a badge that is guessing.
 *
 * IT ASKS RATHER THAN PROBES. A relay line is not something a browser can test
 * without opening one, and opening one to draw a badge would be a cost with no
 * answer in it. Only cookrew.dev knows, because cookrew.dev is the thing
 * holding the line, and it answers in one cheap request.
 *
 * NOTHING IS STORED HERE. The six-character key, the QR, the remembered path —
 * all of it belonged to a ceremony that is gone. A phone is paired on the
 * phone, on its own "Not paired" card, with the token the Mac prints; this
 * page never holds a credential for anybody's Mac.
 *
 * OPEN IS NOT WIRED. It is an anchor in the markup the server sent, pointing
 * at /relay/@user/desktop/<id>/ with nothing on the query, so it works with
 * this script broken, disabled or still loading — and it never leaves
 * cookrew.dev.
 */
;(() => {
  'use strict'
  const list = document.getElementById('me-desktops')
  if (!list) return

  /** How often the badge is asked again while the page is on screen. */
  const REASK_MS = 60000

  const rows = () => [...list.querySelectorAll('li.desktop')]

  const badge = (row, state) => {
    for (const chip of row.querySelectorAll('[data-badge]')) chip.hidden = chip.dataset.badge !== state
  }

  /**
   * IS cookrew.dev HOLDING A LINE FOR THAT MAC?
   *
   * Every kind of no is the same no from in here — a refusal, a network that
   * dropped, an answer that was not JSON. None of them mean the Mac is up, and
   * a badge that says ONLINE on a request that failed is worse than one that
   * says OFFLINE on a Mac that is fine: the first sends a reader to a dead
   * page, the second sends them to look at the Mac.
   */
  async function live(deviceId) {
    try {
      const res = await fetch(`/v2/me/desktops/${encodeURIComponent(deviceId)}/relay-status`, {
        credentials: 'same-origin',
        cache: 'no-store'
      })
      if (!res.ok) return false
      const body = await res.json()
      return body?.live === true
    } catch {
      return false
    }
  }

  /** Rows whose question is still out, so a re-ask never sends a second one. */
  const asking = new Set()

  async function refresh(row) {
    const deviceId = row.dataset.desktop
    if (deviceId === undefined || asking.has(deviceId)) return
    asking.add(deviceId)
    try {
      badge(row, (await live(deviceId)) ? 'online' : 'offline')
    } finally {
      asking.delete(deviceId)
    }
  }

  /*
   * ASKING AGAIN, because a Mac sleeps and a network moves under the page.
   * When the browser says it is back online, when the tab comes forward, and
   * on a slow timer for the case neither fires.
   */
  const reask = () => {
    for (const row of rows()) void refresh(row)
  }
  window.addEventListener('online', reask)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reask()
  })
  setInterval(reask, REASK_MS)

  reask()
})()
