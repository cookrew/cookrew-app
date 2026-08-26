import { renderToStaticMarkup } from 'react-dom/server'
import { ShareOnSave, saveButtonLabel } from '../src/renderer/src/ShareOnSave'

const noop = (): void => undefined
const panel = (title: string, inner: string, note: string): string =>
  `<section class="qa"><h2>${title}</h2><div class="stage"><div class="tf-panel">${inner}</div></div><p class="note">${note}</p></section>`

const saveRow = (access: 'just-me' | 'account' | 'paid', price = ''): string => `
  <div class="tf-head"><span class="tf-title">SAVE TEAM</span><span class="tf-spacer"></span><span class="cr-chip">4 AGENTS</span></div>
  <div style="padding:10px 12px">
    <div class="tf-save">
      <span class="tf-label">SAVE TEAM</span>
      <input class="tf-input" value="Research Crew" readonly>
      <button class="cr-btn sm">${saveButtonLabel(access, false)}</button>
    </div>
    ${renderToStaticMarkup(
      <ShareOnSave access={access} priceUsd={price} door="Conductor" onAccess={noop} onPrice={noop} />
    )}
  </div>`

const out = [
  panel('A · default — Just me (publishes nothing)', saveRow('just-me'),
    'The primary stays plain SAVE. No door fact, because no door is opening.'),
  panel('B · free — anyone with an account', saveRow('account'),
    'The DOOR FACT appears the moment a public option is picked, and the primary renames: the button says everything the click does.'),
  panel('C · paid — price + door fact', saveRow('paid', '2.50'),
    'Price is per SESSION (the instantiator\'s unit). An empty or zero price disables the primary — a paid door that cannot quote at 402 is a caller deception.'),
  panel('D · paid, bad price — refused', saveRow('paid', 'abc'),
    'The primary is disabled and the reason is said, not hidden.')
].join('\n')

process.stdout.write(out)
