// THE FRONT PAGE'S STAGE — the sample fleet at three levels, machines →
// workspaces → agents, and the step into an agent's terminal, which a sample
// only describes.
//
// The front page runs no script (its CSP says script-src 'none'), so stepping
// is four radios and labels: a click on a figure checks the next level's
// radio, the crumbs and the back button check an earlier one, and the arrow
// keys move between them as in any radio group. CSS shows the level whose
// radio is checked. The pictures are drawn at the strata shell's build and
// served from its bundle (site-art.ts, site-art-manifest.ts); everything
// written over them is HTML, placed in percent of the picture it belongs to.
import type { Rect } from '../../src/shared/strata'
import type { MachinesPicture, SampleArt, SeatsPicture, TablesPicture } from './site-art-manifest'
import { esc } from './site-shell'
import { SHELL_PREFIX } from './strata-shell'

const HARNESS_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', shell: 'Shell', other: 'Other' }
const LEVELS = ['machines', 'workspaces', 'agents', 'terminal'] as const

type Sized = { w: number; h: number }
const pct = (r: Rect, p: Sized) =>
  `left:${((r.x / p.w) * 100).toFixed(2)}%;top:${((r.y / p.h) * 100).toFixed(2)}%;width:${((r.w / p.w) * 100).toFixed(2)}%;height:${((r.h / p.h) * 100).toFixed(2)}%`
const at = (x: number, y: number, p: Sized) => `left:${((x / p.w) * 100).toFixed(2)}%;top:${((y / p.h) * 100).toFixed(2)}%`
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const picture = (p: { file: string; w: number; h: number }, alt: string) =>
  `<img src="${SHELL_PREFIX}${esc(p.file)}" alt="${esc(alt)}" width="${Math.round(p.w)}" height="${Math.round(p.h)}" loading="lazy" decoding="async">`

const scene = (layout: 'desk' | 'phone', p: Sized, body: string, cap = '') =>
  `<div class="scene ${layout}" style="aspect-ratio:${p.w}/${p.h}${cap}">${body}</div>`

/** Lamp light under the figure the sample steps into. */
const spot = (r: Rect, p: Sized) => `<div class="spot" style="${pct(r, p)}"></div>`

function machines(p: MachinesPicture, layout: 'desk' | 'phone', id: string): string {
  const parts = [spot(p.tags[0].fig, p), picture(p, 'Sample fleet: three machines')]
  p.tags.forEach((t, i) => {
    const led = t.waiting > 0 ? '<span class="ledw"></span>' : ''
    parts.push(`<div class="tag${i === 0 ? ' hl' : ''}" style="${pct(t.label, p)}"><b>${led}${esc(t.name)}</b><small>${esc(t.sub)}<br>${esc(t.line)}</small></div>`)
    if (t.waiting > 0) parts.push(`<div class="pin" style="${at(t.fig.x + t.fig.w / 2, t.fig.y - 2, p)}">${t.waiting} waiting</div>`)
    // Only the first machine opens; the others are there to be a fleet.
    if (i === 0) parts.push(`<label class="hit" for="${id}1" title="Step into ${esc(t.name)}" style="${pct(union(t.fig, t.label), p)}"></label>`)
  })
  return scene(layout, p, parts.join(''))
}

function tables(p: TablesPicture, layout: 'desk' | 'phone', id: string, machine: string): string {
  const parts = [spot(p.tags[0].fig, p), picture(p, `Sample machine ${machine}: its workspace tables`)]
  p.tags.forEach((t, i) => {
    const line = `${t.agents} agents${t.waiting > 0 ? ` · ${t.waiting} waiting` : ''}`
    parts.push(`<div class="tag${i === 0 ? ' hl' : ''}" style="${pct(t.label, p)}"><b>${esc(t.name)}</b><small>${esc(line)}</small></div>`)
    if (i === 0) parts.push(`<label class="hit" for="${id}2" title="Step into ${esc(t.name)}" style="${pct(union(t.fig, t.label), p)}"></label>`)
  })
  return scene(layout, p, parts.join(''))
}

function seats(p: SeatsPicture, layout: 'desk' | 'phone', id: string, table: string): string {
  const parts = [picture(p, `Sample workspace ${table}: every agent at its seat`)]
  for (const s of p.seats) {
    // The ball, not the whole seat box: what a reader aims at.
    const ball = { x: s.rect.x + s.rect.w * 0.2, y: s.rect.y + s.rect.h * 0.12, w: s.rect.w * 0.6, h: s.rect.h * 0.6 }
    const card = `${s.name}\n${HARNESS_NAME[s.harness] ?? s.harness} · ${s.phase}`
    parts.push(`<label class="hit seat" for="${id}3" data-card="${esc(card)}" title="${esc(s.name)}" style="${pct(ball, p)}"></label>`)
    if (s.phase === 'waiting') parts.push(`<div class="pin" style="${at(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h * 0.08, p)}">${esc(s.name)}</div>`)
  }
  // A short table drawn full width would be taller than the screen: cap the desktop stage's height.
  const cap = layout === 'desk' ? `;max-width:${Math.round((440 * p.w) / p.h)}px;margin:0 auto` : ''
  return scene(layout, p, parts.join(''), cap)
}

const BACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>'

/** The stage over the sample's pictures, with radio ids under `id` (one stage per page). */
export function sampleStage(art: SampleArt, id = 'lv'): string {
  const { machine, table } = art
  const radios = LEVELS.map((name, i) => `<input class="lvr" type="radio" name="${id}" id="${id}${i}"${i === 0 ? ' checked' : ''} aria-label="Level ${i}: ${name}">`).join('')
  const bar =
    '<div class="sbar">' +
    [1, 2, 3].map((i) => `<label class="back bk${i}" for="${id}${i - 1}" title="Out one level">${BACK}</label>`).join('') +
    `<span class="crumbs"><label class="cr c0" for="${id}0">Sample fleet</label>` +
    `<span class="c1"><span class="sep">/</span><label class="cr c1" for="${id}1">${esc(machine)}</label></span>` +
    `<span class="c2"><span class="sep">/</span><label class="cr c2" for="${id}2">${esc(table)}</label></span>` +
    '<span class="c3"><span class="sep">/</span><span class="cr c3">terminal</span></span></span>' +
    `<span class="dots"><span class="lvname">${LEVELS.map((name, i) => `<span class="n${i}">Level ${i} · ${name}</span>`).join('')}</span>` +
    LEVELS.map((name, i) => `<label for="${id}${i}" title="Level ${i}: ${name}"></label>`).join('') +
    '</span><span class="pill sample">Sample</span></div>'
  const terminal =
    '<div class="l3card"><div class="tb"><i></i><i></i><i></i></div>' +
    '<p>Level 3 is the agent’s own terminal: the desktop companion’s full view, every turn a checkpoint on the rail beside it.</p>' +
    '<p>A sample never opens one. Sign in, and the same three steps lead into your own agents.</p>' +
    '<p class="row"><a class="btn sm primary" href="/me">Sign in</a><a class="btn sm" href="#download">Get the app</a></p></div>'
  const levels =
    '<div class="lvs">' +
    `<div class="lv l0">${machines(art.machines.desk, 'desk', id)}${machines(art.machines.phone, 'phone', id)}</div>` +
    `<div class="lv l1">${tables(art.tables.desk, 'desk', id, machine)}${tables(art.tables.phone, 'phone', id, machine)}</div>` +
    `<div class="lv l2">${seats(art.seats.desk, 'desk', id, table)}${seats(art.seats.phone, 'phone', id, table)}</div>` +
    `<div class="lv l3">${terminal}</div></div>`
  // What to do next, per level; the arrow keys only matter where there is a keyboard.
  const next = [`${esc(machine)} to step in`, `${esc(table)} to step in`, 'any agent for its terminal']
  const how =
    next.map((what, i) => `<span class="n${i}"><span class="pointer">Click</span><span class="touch">Tap</span> ${what}</span>`).join('') +
    '<span class="n3">Back, or a crumb, to step out</span><span class="pointer"> · ← → between levels</span>'
  const hint = `<div class="svhint"><span>A sample fleet, drawn by the same kit that draws yours.</span><span class="how">${how}</span></div>`
  return `<div class="strata" role="group" aria-label="Sample fleet, three levels">${radios}${bar}${levels}${hint}</div>`
}

/** The stage's stylesheet; the page's tokens (--ink, --cream…) come from SITE_STYLE. */
export const STRATA_STAGE_CSS = `
.hero.levels .wrap{display:block}
.hero.levels .lede{max-width:none}
.strata{--dot:rgba(45,42,32,.13);--spot:rgba(255,205,70,.55);--waiting:#ff453a;position:relative;margin:22px 0 4px;border:2px solid var(--line);background:var(--cream);border-radius:14px;box-shadow:4px 4px 0 var(--line);overflow:hidden;background-image:radial-gradient(var(--dot) 1px,transparent 1.2px);background-size:18px 18px}
@media (prefers-color-scheme:dark){.strata{--dot:rgba(239,230,210,.09);--spot:rgba(255,196,70,.22)}}
.lvr{position:absolute;opacity:0;pointer-events:none}
.sbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1.5px solid var(--line-soft);background:var(--cream-hi)}
.sbar .back{width:30px;height:30px;border-radius:50%;border:2px solid var(--line);place-items:center;cursor:pointer;background:var(--cream-hi);flex:0 0 auto}
.sbar .back svg{width:14px;height:14px}
.sbar .c1,.sbar .c2,.sbar .c3,.sbar .back{display:none}
.sbar .crumbs{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;font-size:14px;white-space:nowrap}
.sbar .sep{color:var(--muted);padding:0 2px}
.sbar .cr{color:var(--muted);cursor:pointer;padding:3px 8px;border-radius:999px}
.sbar label.cr:hover{background:var(--cream-md);color:var(--ink)}
.sbar span.cr{cursor:default}
.dots{display:flex;gap:6px;margin-left:auto;align-items:center}
.dots label{width:10px;height:10px;border-radius:50%;border:2px solid var(--line);cursor:pointer}
.dots .lvname{font-size:12px;color:var(--muted);margin-right:4px;white-space:nowrap}
.dots .lvname span{display:none}
.sbar .pill.sample{font:8px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;background:var(--amber-soft);border:1.5px solid var(--line);border-radius:999px;padding:2px 8px}
.lv{display:none;animation:lvIn .34s cubic-bezier(.2,.8,.2,1)}
@keyframes lvIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.lv{animation:none}}
.lvr:nth-of-type(1):checked~.lvs .l0,.lvr:nth-of-type(2):checked~.lvs .l1,.lvr:nth-of-type(3):checked~.lvs .l2,.lvr:nth-of-type(4):checked~.lvs .l3{display:block}
.lvr:nth-of-type(2):checked~.sbar .c1,.lvr:nth-of-type(3):checked~.sbar :is(.c1,.c2),.lvr:nth-of-type(4):checked~.sbar :is(.c1,.c2,.c3){display:inline-flex}
.lvr:nth-of-type(2):checked~.sbar .bk1,.lvr:nth-of-type(3):checked~.sbar .bk2,.lvr:nth-of-type(4):checked~.sbar .bk3{display:inline-grid}
.lvr:nth-of-type(1):checked~.sbar .dots label:nth-of-type(1),.lvr:nth-of-type(2):checked~.sbar .dots label:nth-of-type(2),.lvr:nth-of-type(3):checked~.sbar .dots label:nth-of-type(3),.lvr:nth-of-type(4):checked~.sbar .dots label:nth-of-type(4){background:var(--ink);width:22px;border-radius:6px}
.svhint .how>[class^=n],.svhint .touch{display:none}
.lvr:nth-of-type(1):checked~:is(.sbar,.svhint) .n0,.lvr:nth-of-type(2):checked~:is(.sbar,.svhint) .n1,.lvr:nth-of-type(3):checked~:is(.sbar,.svhint) .n2,.lvr:nth-of-type(4):checked~:is(.sbar,.svhint) .n3{display:inline}
.lvr:nth-of-type(1):checked~.sbar .crumbs .c0,.lvr:nth-of-type(2):checked~.sbar .crumbs .c1,.lvr:nth-of-type(3):checked~.sbar .crumbs .c2,.lvr:nth-of-type(4):checked~.sbar .crumbs .c3{color:var(--ink);font-weight:650}
.lvr:focus-visible~.sbar .dots{outline:2px solid var(--line);outline-offset:4px;border-radius:8px}
.strata .scene{position:relative;width:100%}
.strata .scene>img{display:block;width:100%;height:auto}
.strata .scene.phone{display:none}
.strata .lv.l0,.strata .lv.l1{padding-bottom:14px}
.strata .spot{position:absolute;background:radial-gradient(closest-side,var(--spot),transparent);pointer-events:none}
.strata .hit{position:absolute;cursor:pointer;border-radius:14px}
.strata .hit:hover{background:radial-gradient(closest-side,var(--spot),transparent)}
.strata .hit.seat{border-radius:50%}
.strata .hit.seat:hover::after{content:attr(data-card);position:absolute;left:50%;bottom:100%;transform:translate(-50%,-6px);white-space:pre;background:var(--cream-hi);border:2px solid var(--line);border-radius:10px;padding:4px 8px;font-size:12px;line-height:1.35;box-shadow:2px 2px 0 var(--line);z-index:3;pointer-events:none}
.strata .tag{position:absolute;display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:none;text-align:center}
.strata .tag b{display:inline-flex;gap:5px;align-items:center;background:var(--cream-hi);border:2px solid var(--line);border-radius:999px;padding:1px 10px;font-size:13.5px;box-shadow:1.5px 1.5px 0 var(--line)}
.strata .tag.hl b{background:var(--ink);color:var(--cream-hi)}
.strata .tag small{font-size:12px;color:var(--muted);line-height:1.3}
.strata .ledw{width:8px;height:8px;border-radius:50%;background:var(--waiting)}
.strata .pin{position:absolute;transform:translate(-50%,-100%);background:var(--cream-hi);border:2px solid var(--line);border-radius:999px;padding:0 8px;font-size:12.5px;font-weight:600;display:flex;gap:5px;align-items:center;white-space:nowrap;pointer-events:none}
.strata .pin::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--waiting)}
.l3card{margin:28px auto;max-width:640px;border:2px solid var(--line);border-radius:12px;background:var(--phos-bg);color:#e9e2cf;padding:18px 20px;box-shadow:4px 4px 0 var(--line)}
.l3card .tb{display:flex;gap:6px;margin-bottom:12px}.l3card .tb i{width:10px;height:10px;border-radius:50%;background:#3a352b}
.l3card p{margin:0 0 12px;font:14px/1.6 var(--font-mono);color:#cfc6b0}
.l3card p.row{margin:0;display:flex;gap:8px;flex-wrap:wrap}
.svhint{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 12px;border-top:1.5px solid var(--line-soft);font-size:12.5px;color:var(--muted)}
@media (pointer:coarse){.svhint .pointer{display:none}.svhint .touch{display:inline}}
@media (max-width:640px){
.strata .scene.desk{display:none}.strata .scene.phone{display:block}
.dots .lvname,.sbar .pill.sample{display:none}
.lvr:not(:nth-of-type(1)):checked~.sbar :is(label.c0,span.c1>.sep){display:none}
.sbar .cr{padding:3px 4px}.sbar .crumbs{font-size:13px}
.strata .tag b{font-size:12px;padding:0 7px}.strata .tag small{font-size:10.5px}
.l3card{margin:16px 12px}
}`
