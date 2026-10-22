// The figures gallery (/gallery.html on the strata preview): the live fleet
// through FigureKit, budgets, then every figure in every state.
import './gallery.css'
import { renderFleet } from './fleet'
import { avatarsHtml, cardsHtml, containersHtml, machinesHtml } from './matrix'
import { kb, summary } from './stats'

const root = document.getElementById('gallery')
if (!root) throw new Error('gallery: #gallery missing from gallery.html')

const section = (id: string) => {
  const el = document.createElement('section')
  el.id = id
  root.appendChild(el)
  return el
}

const budgetsHtml = (): string => {
  const rows = summary()
    .map((s) => {
      const ok = s.over.length === 0
      return (
        `<tr><td>${s.family}</td><td class="num">${s.count}</td><td class="num">${kb(s.budget)}</td>` +
        `<td class="num">${kb(s.mean)}</td><td class="num">${s.biggest ? kb(s.biggest.bytes) : '–'}</td><td>${s.biggest?.label ?? ''}</td>` +
        `<td class="num">${s.busiest?.elements ?? '–'}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? 'within' : `${s.over.length} over`}</td></tr>`
      )
    })
    .join('')
  return (
    '<h2>Budgets <span class="muted">· every figure drawn on this page</span></h2>' +
    '<table><thead><tr><th>family</th><th>figures</th><th>budget</th><th>mean</th><th>largest</th><th>which</th><th>most elements</th><th></th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  )
}

const theme = document.getElementById('theme') as HTMLSelectElement
const applyTheme = () => {
  if (theme.value === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme.value
}
theme.addEventListener('change', applyTheme)
const asked = new URLSearchParams(location.search).get('theme')
if (asked === 'light' || asked === 'dark') {
  theme.value = asked
  applyTheme()
}

const motion = document.getElementById('motion') as HTMLInputElement
const applyMotion = () =>
  document.querySelectorAll('svg.cf').forEach((svg) => {
    const el = svg as SVGSVGElement
    if (motion.checked) el.unpauseAnimations()
    else el.pauseAnimations()
  })
motion.addEventListener('change', applyMotion)
if (matchMedia('(prefers-reduced-motion: reduce)').matches) motion.checked = false

const fleet = section('fleet')
const phone = section('phone-frames')
const budgets = section('budgets')
const rest = section('matrices')

renderFleet(fleet, phone)
  .catch((error: unknown) => {
    fleet.innerHTML = `<h2>Fleet</h2><p class="bad">could not load the preview fleet: ${String(error)}</p>`
  })
  .finally(() => {
    rest.innerHTML = machinesHtml() + containersHtml() + avatarsHtml() + cardsHtml()
    budgets.innerHTML = budgetsHtml()
    applyMotion()
    document.documentElement.dataset.ready = '1'
  })
