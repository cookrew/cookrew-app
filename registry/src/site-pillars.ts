import { FRAMES, frameImg, type Frame } from './site-frames'
import { esc } from './site-shell'
import { PILLARS, ROADMAP, STATUS, type Claim, type ClaimStatus, type Pillar } from './site-content'

/**
 * THE THREE PILLARS AND THE ROADMAP — the front page's argument, drawn from
 * site-content.ts. Every claim wears its status, so a reader can tell what
 * the app does today from what is in dev, in beta, tried once by hand, or
 * only planned; the legend says what each label means.
 *
 * THE PICTURES ARE RECORDINGS. Each pillar shows one still taken from the
 * running app (site-frames.ts, retaken on 2026-11-01), captioned with what
 * was clicked and its date. Nothing here is drawn to look like the app: the
 * one drawing, the route, is labelled a diagram and drawn as boxes of text.
 */

/** The day the stills were retaken from the running app (git log of registry/assets/site). */
const RECORDED = '1 Nov 2026'

export function statusPill(status: ClaimStatus): string {
  return `<span class="st st-${status}">${esc(STATUS[status].label)}</span>`
}

function legend(): string {
  const rows = (Object.keys(STATUS) as ClaimStatus[]).map((s) => `<div>${statusPill(s)}<span>${esc(STATUS[s].meaning)}</span></div>`)
  return `<div class="st-legend" id="status" aria-label="What the labels mean">${rows.join('')}</div>`
}

function claim(c: Claim): string {
  return `<li class="claim" data-status="${c.status}">${statusPill(c.status)}<div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></li>`
}

function still(p: Pillar): string {
  if (p.frame === null) return ''
  const frame: Frame = FRAMES[p.frame]
  const portrait = frame.height > frame.width
  return `<figure class="shot${portrait ? ' portrait' : ''}">${frameImg(frame, { sizes: portrait ? '300px' : '(max-width: 860px) 100vw, 40vw' })}<figcaption><span class="rec">● REC</span><span>Recorded from the running app, ${RECORDED}; the interface has moved on since. ${esc(frame.caption)}</span></figcaption></figure>`
}

/** The route as it is today, and the one hand-made experiment, as text in boxes: a diagram, never a screen. */
function routeDiagram(): string {
  const box = (title: string, sub: string, cls = ''): string => `<li class="${cls}"><b>${esc(title)}</b><span>${esc(sub)}</span></li>`
  return `<figure class="route-diagram" aria-label="Diagram of how a harness reaches a model">
<p class="route-row">${statusPill('shipped')} on every machine</p>
<ol>${box('Agent card', 'Claude Code · Codex · OpenCode · Pi')}${box('Magpie, this machine', 'on loopback, run by you')}${box('Your models', 'subscription · API key · local model')}</ol>
<p class="route-row">${statusPill('experiment')} ssh tunnel, 12 Nov 2026 — not a product path</p>
<ol class="exp">${box('Agent on machine A', 'its tools run on A')}${box('Magpie on machine B', 'reached over ssh -L, by hand', 'dashed')}${box('B’s model', 'one model, one run')}</ol>
<figcaption>Diagram, not a screenshot. The Routing panel itself has not been recorded for this page yet.</figcaption>
</figure>`
}

function pillar(p: Pillar, index: number): string {
  return `<section class="pillar" id="${p.id}"><div class="wrap">
<p class="kicker"><span class="no">0${index + 1}</span>${esc(p.kicker)}</p>
<h2>${esc(p.title)}</h2>
<p class="lede">${esc(p.lede)}</p>
<div class="pillar-body"><ul class="claims">${p.claims.map(claim).join('')}</ul>
<div class="pillar-media">${p.id === 'gateway' ? routeDiagram() : ''}${still(p)}</div></div>
</div></section>`
}

export function pillarsSection(): string {
  return `<section class="pillars-intro"><div class="wrap">${legend()}</div></section>
${PILLARS.map(pillar).join('\n')}`
}

export function roadmapSection(): string {
  return `<section id="roadmap"><div class="wrap">
<p class="kicker"><span class="no">ROADMAP</span>a trusted room first</p>
<h2>Where this is going</h2>
<ol class="roadmap">${ROADMAP.map((r) => `<li><div class="roadmap-head"><b>${esc(r.phase)}</b>${statusPill(r.status)}</div><ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></li>`).join('')}</ol>
</div></section>`
}
