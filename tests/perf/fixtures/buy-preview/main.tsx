import { createRoot } from 'react-dom/client'
import { ImportGate } from '../../../../src/renderer/src/ImportGate'
import type { CookrewApi, ServeFacePreview } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'

/**
 * THE REAL IMPORT GATE, ALONE ON A PAGE — a fixture for the click test
 * (tests/seat-buy-click.test.ts).
 *
 * The component is the app's own; so is everything behind the bridge. The
 * bridge below speaks the PHONE'S wire (remote-api.ts · serveGate / Checkout /
 * Settle: POST /api/serve/<verb>), and the test stands the desktop's real
 * route handler behind it, so a press here travels the same path a press on
 * the phone does: route → gate verbs → cookrew.dev → the door.
 *
 * WHAT LEAVES THE SHEET IS RECORDED, because the point of the test is what
 * must not: a card added to the canvas, a window opened, a link followed.
 * The card payment's hosted page is deliberately NOT opened — there is no
 * browser to pay in here, and the test's Stripe is one function at the door.
 */

const params = new URLSearchParams(location.search)
const link = params.get('link') ?? ''
const token = params.get('token') ?? ''

const post = async <T,>(verb: string, body: unknown): Promise<T> => {
  const response = await fetch(`/api/serve/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return (await response.json()) as T
}

const left: { nodes: unknown[]; windows: string[]; placed: unknown; dismissed: boolean } = {
  nodes: [],
  windows: [],
  placed: null,
  dismissed: false
}

/** Whoever listens for "the account changed" — the sheet, once mounted. */
const accountListeners = new Set<() => void>()

/**
 * THE PAGE'S CLOCK CAN BE MOVED FORWARD, and only forward. A card session
 * lives for up to an hour; the test that watches the wait end cannot. Nothing
 * else about time is faked — the poll's own timer still ticks for real.
 */
const realNow = Date.now.bind(Date)
let skipped = 0
Date.now = () => realNow() + skipped

const bridge: Partial<CookrewApi> = {
  onAccountChanged: (listener: () => void) => {
    accountListeners.add(listener)
    return () => {
      accountListeners.delete(listener)
    }
  },
  serveGate: (address, intent) => post('gate', { link: address, ...(intent === 'buy' ? { intent } : {}) }),
  serveCheckout: (address) => post('checkout', { link: address }),
  serveSettle: (address, rail, session, shown) =>
    post('settle', { link: address, rail, session, ...(shown === undefined ? {} : { shown }) }),
  addNode: async (node) => {
    left.nodes.push(node)
    return node
  },
  openExternal: async (url) => {
    left.windows.push(url)
  }
}

const face: ServeFacePreview = {
  name: 'COOKREW Alpha',
  serviceId: 'svc-alpha',
  slug: 'alpha',
  door: 'Pilot',
  access: 'paid',
  priceUsd: '1.00',
  version: 1,
  agents: 2,
  paymentRails: ['stripe']
}

Object.assign(window, {
  cookrew: bridge,
  open: (url?: string | URL) => {
    left.windows.push(String(url))
    return null
  },
  __left: () => left,
  __skip: (ms: number) => {
    skipped += Math.max(0, ms)
  },
  __accountChanged: () => {
    for (const listener of accountListeners) listener()
  }
})

createRoot(document.getElementById('root')!).render(
  <ImportGate
    link={link}
    face={face}
    onOpen={(paid) => {
      left.placed = paid ?? 'free'
    }}
    onDismiss={() => {
      left.dismissed = true
    }}
  />
)
