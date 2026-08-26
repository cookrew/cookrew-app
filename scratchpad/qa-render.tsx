import { renderToStaticMarkup } from 'react-dom/server'
import { ServedTeamCard, type ServedTeam } from '../src/renderer/src/ServedTeamCard'
import { AddCrewSheet } from '../src/renderer/src/AddCrewSheet'

const noop = (): void => undefined
const team: ServedTeam = {
  serviceId: 'svc-research-crew', templateId: 'Research Crew', slug: 'research-crew',
  access: 'paid', priceUsd: '2.50', address: 'http://192.168.1.20:8639/research-crew'
}
const wrap = (t: string, inner: string, note: string): string =>
  `<section class="qa"><h2>${t}</h2><div class="stage">${inner}</div><p class="note">${note}</p></section>`

const dock = `<div class="cr-dock-presets qa-dock">
  <button class="cr-chip clickable amber">CLAUDE CODE</button>
  <button class="cr-chip clickable">CODEX</button>
  <button class="cr-chip clickable crew-chip"><span class="crew-chip-dot"></span>Triage · @ana</button>
  <button class="cr-chip clickable crew-chip locked"><span class="crew-chip-dot"></span>Research Crew<span class="crew-chip-price">2.50</span></button>
  <button class="cr-chip clickable crew-chip ended" disabled><span class="crew-chip-dot"></span>Old Crew</button>
  <button class="cr-chip clickable crew-add">+ ADD BY LINK</button>
</div>`

const shelf = `<div class="tf-source" style="padding:10px">
  <span class="tf-label">SOURCE</span>
  <button class="cr-chip clickable amber">LIVE CANVAS</button>
  <span class="tf-team-chip"><button class="cr-chip clickable">Research Crew</button><button class="cr-chip clickable tf-serving">TAKING CALLS · 2</button></span>
  <span class="tf-team-chip"><button class="cr-chip clickable">Daily Standup</button></span>
</div>`

process.stdout.write([
  wrap('A · the served team card (state C)',
    renderToStaticMarkup(<ServedTeamCard team={team} door="Conductor" onStopped={noop} onClose={noop} />),
    'The address leads — it is the thing you hand over. Sessions live HERE, on the thing you published; that is what let WHO CAN CALL be retired rather than moved.'),
  wrap('B · add a crew (import entry)',
    renderToStaticMarkup(<AddCrewSheet onClose={noop} onAdded={noop} />),
    'Adding is free and inert: the primary is disabled until an address is pasted.'),
  wrap('C · the dock — CREWS, the fourth family', dock,
    'Granted (plain) · locked (dashed + price → opens the gate) · ended (dimmed, disabled, never vanishes).'),
  wrap('D · the shelf — the standing state', shelf,
    'A team quietly serving must be visible at rest: TAKING CALLS · n, clickable into its card.')
].join('\n'))
