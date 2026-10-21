// Every figure in every state, at every size: the matrices the owner reviews.
// Container names here are invented; real ones only ever arrive at runtime.
import type { AgentPhase, Harness, MachineKind, MachineLink, PhaseSource } from '../../shared/strata'
import { ARCHETYPES, avatarArt, cardArt, containerArt, desktopFormOf, machineArt, type Archetype } from '../figures'
import type { AvatarSize } from '../seams'
import { elementsOf, kb, record } from './stats'

const KINDS: MachineKind[] = ['laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox', 'unknown']
const STATES: Array<{ link: MachineLink; reached?: boolean; label: string }> = [
  { link: 'live', label: 'online' },
  { link: 'connecting', label: 'connecting' },
  { link: 'unpaired', label: 'unpaired' },
  { link: 'outdated', label: 'outdated' },
  { link: 'offline', label: 'offline (cached)' },
  { link: 'error', label: 'error' },
  { link: 'offline', reached: false, label: 'never reached' }
]
const DESKTOP_LABELS = ['Mac mini', 'Mac Studio', 'Mac Pro', 'iMac (24-inch)']
const SAMPLE_NAMES: Record<Archetype, string> = {
  workbench: 'Monorepo',
  bookshelf: 'Paper Notes',
  house: 'Home Lab',
  crate: 'Media',
  vault: 'Backups',
  lockers: 'CI Night Shift',
  pipes: 'Data Pipes',
  sandbox: 'Throwaway',
  drawers: 'Brand Design',
  lab: 'LLM Evals',
  bleachers: 'Crew'
}
const PHASES: AgentPhase[] = ['idle', 'thinking', 'waiting', 'replied', 'offline']
const SOURCES: PhaseSource[] = ['live', 'probe', 'ledger']
const HARNESSES: Harness[] = ['claude', 'codex', 'opencode', 'pi', 'shell', 'other']
const AVATAR_PX: Record<AvatarSize, number> = { dot: 12, small: 30, full: 88 }

const at = (svg: string, w: number) => svg.replace('<svg ', `<svg width="${w.toFixed(1)}" `)
const cell = (svg: string, label: string) => `<div class="cell">${svg}<small>${label}</small></div>`

export const machinesHtml = (): string =>
  '<h2 id="machines">Machines <span class="muted">· every kind × link state, at 96 and 240 px</span></h2>' +
  [96, 240]
    .map(
      (px) =>
        `<h3>${px} px</h3>` +
        KINDS.map(
          (kind) =>
            `<div class="grid">${STATES.map((s) => {
              const art = record('machine', `${kind}/${s.label}`, machineArt({ kind, link: s.link, reached: s.reached }))
              return cell(at(art.svg, px), `${kind} · ${s.label} · ${kb(art.svg.length)} · ${elementsOf(art.svg)} el`)
            }).join('')}</div>`
        ).join('')
    )
    .join('') +
  '<h3>desktop forms <span class="muted">· from the profile label (proposed seam field: model)</span></h3><div class="grid">' +
  DESKTOP_LABELS.flatMap((model) =>
    (['live', 'offline'] as const).map((link) => {
      const art = record('machine', `desktop ${model}/${link}`, machineArt({ kind: 'desktop', link, model }))
      return cell(at(art.svg, 240), `${model} · ${desktopFormOf(model)} · ${link} · ${kb(art.svg.length)}`)
    })
  ).join('') +
  '</div>'

export const containersHtml = (): string =>
  '<h2 id="containers">Containers <span class="muted">· every archetype at 1, 5, 14, 33, 48 and 60 seats (+K past 48)</span></h2>' +
  ARCHETYPES.map(
    (archetype) =>
      `<h3>${archetype} <span class="muted">· "${SAMPLE_NAMES[archetype]}"</span></h3><div class="grid">${[1, 5, 14, 33, 48, 60]
        .map((slots) => {
          const art = record('container', `${archetype}/${slots}`, containerArt({ name: SAMPLE_NAMES[archetype], slots, archetype }))
          return cell(at(art.svg, art.viewBox.w * 0.5), `${slots} · ${kb(art.svg.length)} · ${elementsOf(art.svg)} el`)
        })
        .join('')}</div>`
  ).join('')

export const avatarsHtml = (): string =>
  '<h2 id="avatars">Avatars <span class="muted">· phase × source × harness, at full, small and dot</span></h2>' +
  (['full', 'small', 'dot'] as AvatarSize[])
    .map((size) =>
      SOURCES.map(
        (source) =>
          `<h3>${size} · ${source}${source === 'live' ? '' : ' (last known)'}</h3><div class="grid">${PHASES.flatMap((phase) =>
            HARNESSES.map((harness) => {
              const art = record('avatar', `${phase}/${source}/${harness}/${size}`, avatarArt({ phase, source, harness, size }))
              const px = AVATAR_PX[size] * (size === 'dot' ? 2 : 1)
              return `<span title="${phase} · ${harness} · ${art.svg.length} B">${at(art.svg, px)}</span>`
            })
          ).join('')}</div>`
      ).join('')
    )
    .join('')

export const cardsHtml = (): string =>
  '<h2 id="cards">Attachment cards <span class="muted">· hover an avatar in the fleet above to fan them</span></h2><div class="grid">' +
  (['note', 'browser'] as const)
    .flatMap((kind) =>
      [false, true].map((shared) => {
        const art = record('card', `${kind}/${shared}`, cardArt({ kind, shared }))
        return cell(at(art.svg, 96), `${kind}${shared ? ' · shared' : ''} · ${art.svg.length} B`)
      })
    )
    .join('') +
  '</div>'
