import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'

/**
 * THE REAL APP WITH ONE SEALED SLOT WORTH LOOKING AT — a preview fixture.
 *
 * The demo api (in-memory secrets, no file) seeds its welcome note; this
 * rewrites it to the R4 mock's note: a heading, one sentence, and the slot
 * line `🔒 stripe-key`. A headless Chrome then photographs the chip on the
 * card face, the empty block on the zoomed card, and the block after SEAL.
 * Nothing here touches the app that is serving the owner's real cards.
 */
async function boot(): Promise<void> {
  const api = cookrew()
  await api.updateNode('demo-note', {
    name: 'Stripe keys',
    customName: 'Stripe keys',
    content:
      '# Stripe keys\n\nTest cards live in docs/. The live key goes in a sealed slot, never in this text.\n\n🔒 stripe-key\n',
    // Tall enough for the body and the block together, as an owner would size it.
    size: { width: 300, height: 380 }
  })
  if (new URLSearchParams(location.search).get('phone') === '1') document.body.classList.add('cookrew-mobile')
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
