// The live fleet from the preview's mock (or the real fixture, at runtime
// only — nothing here is committed): every machine with its workspaces'
// dots in its portal, then every workspace as its container with the agents
// seated, a hover summary, and attachment cards that fan out. Timed cold.
import type { FleetMachine, LevelsAgent, LevelsSnapshot, LevelsWorkspace, MachineLink } from '../../shared/strata'
import { colorFigures, portalSkew } from '../figures'
import { escapeText } from '../figures/iso/pen'
import { kb, record } from './stats'

interface Seen {
  row: FleetMachine
  link: MachineLink
  levels: LevelsSnapshot | null
}

const load = async (): Promise<Seen[]> => {
  const [rows, cache] = await Promise.all([
    fetch('/fleet.json').then((r) => r.json() as Promise<FleetMachine[]>),
    fetch('/preview/cache.json').then((r): Promise<Record<string, LevelsSnapshot>> => (r.ok ? r.json() : Promise.resolve({})))
  ])
  return Promise.all(
    rows.map(async (row) => {
      if (!row.online) return { row, link: 'offline' as const, levels: cache[row.id] ?? null }
      const res = await fetch(`${row.base}api/levels`)
      return { row, link: res.ok ? ('live' as const) : ('error' as const), levels: res.ok ? ((await res.json()) as LevelsSnapshot) : null }
    })
  )
}

const svgAt = (svg: string, w: number) => svg.replace('<svg ', `<svg width="${w.toFixed(1)}" `)

const portalHtml = (m: Seen, size: number): string => {
  // reached as the levels scene decides it: someone saw it once, or a snapshot exists
  const input = { kind: m.row.profile?.kind ?? 'unknown', link: m.link, reached: m.row.lastSeenAt !== null || m.levels !== null }
  const art = record('machine', `${input.kind}/${m.link}`, colorFigures.machine(input))
  const k = size / art.viewBox.w
  const skew = portalSkew(art.anchors.portal)
  const p = art.anchors.portal
  const dots = (m.levels?.workspaces ?? [])
    .map((w) => `<div class="ws">${w.agents.map((a) => colorFigures.avatar({ phase: a.phase, source: a.phaseSource, harness: a.harness, size: 'dot' }).svg).join('')}</div>`)
    .join('')
  const style = `left:${p.x * k}px;top:${(p.y + p.h) * k - skew.height * k}px;width:${skew.width * k}px;height:${skew.height * k}px;transform:${skew.transform}`
  return `<div class="cell"><div class="machine${m.levels && m.link !== 'live' ? ' stale' : ''}">${svgAt(art.svg, size)}<div class="portal" style="${style}">${dots}</div></div><small>${escapeText(m.row.name)} · ${m.row.profile?.kind ?? 'unknown'} · ${m.link}</small></div>`
}

const summaryOf = (a: LevelsAgent) =>
  [`<b>${escapeText(a.name)}</b> · ${escapeText(a.harness)}${a.model ? ' · ' + escapeText(a.model) : ''}`, escapeText(`${a.phase} (${a.phaseSource})`), a.task && escapeText(a.task), a.reply && `↳ ${escapeText(a.reply)}`]
    .filter(Boolean)
    .join('<br>')

const containerOf = (w: LevelsWorkspace) => colorFigures.container({ name: w.name, slots: w.agents.length, ...(w.traits?.length && { traits: w.traits }) })

const containerHtml = (w: LevelsWorkspace, scale: number): string => {
  const art = containerOf(w)
  record('container', `${art.theme}/${w.agents.length}`, art)
  const seats = art.anchors.more ? w.agents.slice(0, art.capacity - 1) : w.agents
  const avatars = seats
    .map((a, i) => {
      const r = art.anchors[`slot:${i}`]
      const av = record('avatar', `${a.phase}/${a.phaseSource}/${a.harness}/small`, colorFigures.avatar({ phase: a.phase, source: a.phaseSource, harness: a.harness, size: 'small' }))
      const fan = av.anchors.fan
      const side = r.w * scale
      const cards = a.attachments
        .slice(0, 5)
        .map((c, n) => {
          const card = record('card', `${c.kind}/${c.shared}`, colorFigures.attachment({ kind: c.kind, shared: c.shared }))
          const cw = side * 0.62
          return `<div class="card" style="--i:${n};left:${(fan.x / av.viewBox.w) * side}px;top:${(fan.y / av.viewBox.h) * side}px;width:${cw}px">${svgAt(card.svg, cw)}</div>`
        })
        .join('')
      return `<div class="av" style="left:${r.x * scale}px;top:${r.y * scale}px;width:${side}px;height:${side}px">${cards}${av.svg}<div class="tip">${summaryOf(a)}${a.attachments.length ? `<br>${a.attachments.length} attached` : ''}</div></div>`
    })
    .join('')
  const seatPx = art.anchors['slot:0'] ? ` · seat ${(art.anchors['slot:0'].w * scale).toFixed(0)} px` : ''
  return `<div class="cell"><div class="box" style="width:${art.viewBox.w * scale}px">${svgAt(art.svg, art.viewBox.w * scale)}${avatars}</div><small>${escapeText(w.name)} · ${art.theme} · ${w.agents.length} agents · ${kb(art.svg.length)}${seatPx}</small></div>`
}

const frames = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))

const PHONE_INNER = 390 - 2 * 16

/** One phone frame per machine: the same tables as the desktop, one shared scale so the longest fits the screen. */
const phoneHtml = (fleet: Seen[]): string =>
  `<h2 id="phone">Phone <span class="muted">· 390 × 844, 16 px inset, the same tables at one scale</span></h2><div class="fleetrow">` +
  fleet
    .filter((m) => m.levels && m.levels.workspaces.length > 0)
    .map((m) => {
      const scale = Math.min(...m.levels!.workspaces.map((w) => PHONE_INNER / containerOf(w).viewBox.w))
      return `<div class="phone"><b>${escapeText(m.row.name)}</b>${m.levels!.workspaces.map((w) => containerHtml(w, scale)).join('')}</div>`
    })
    .join('') +
  '</div>'

export const renderFleet = async (root: HTMLElement, phone?: HTMLElement): Promise<void> => {
  root.innerHTML = '<h2>Fleet <span class="muted">· live from this preview (real fixture when started with --fixture)</span></h2><p class="muted">loading…</p>'
  const fleet = await load()
  const t0 = performance.now()
  const machines = fleet.map((m) => portalHtml(m, 240)).join('')
  const workspaces = fleet
    .filter((m) => m.levels)
    .map((m) => `<h3>${escapeText(m.row.name)}</h3><div class="fleetrow">${m.levels!.workspaces.map((w) => containerHtml(w, 0.62)).join('')}</div>`)
    .join('')
  const t1 = performance.now()
  const agents = fleet.reduce((n, m) => n + (m.levels?.workspaces.reduce((s, w) => s + w.agents.length, 0) ?? 0), 0)
  const spaces = fleet.reduce((n, m) => n + (m.levels?.workspaces.length ?? 0), 0)
  root.innerHTML =
    `<h2>Fleet <span class="muted">· live from this preview (real fixture when started with --fixture)</span></h2>` +
    `<p class="timing" id="timing">${fleet.length} machines · ${spaces} workspaces · ${agents} agents — figures drawn cold in <b>${(t1 - t0).toFixed(1)} ms</b>` +
    ` <span id="paint" class="muted">· painting…</span></p>` +
    `<div class="fleetrow">${machines}</div>${workspaces}`
  await frames()
  const t2 = performance.now()
  const paint = root.querySelector('#paint')
  if (paint) paint.textContent = `· to first paint ${(t2 - t0).toFixed(0)} ms (draw + DOM + layout)`
  document.documentElement.dataset.firstPaintMs = (t2 - t0).toFixed(0)
  if (phone) phone.innerHTML = phoneHtml(fleet)
}
