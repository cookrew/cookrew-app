import { DEMO, figure } from './site-frames'
import { esc } from './site-shell'
import { pillars, roadmap, status, type Claim, type ClaimStatus, type Pillar } from './site-content'
import { tr } from './site-lang'

/**
 * THE THREE PILLARS AND THE ROADMAP — the front page's argument, drawn from
 * site-content.ts. Every claim wears its status, so a reader can tell what
 * the app does today from what is in dev, in beta, tried once by hand, or
 * only planned; the legend says what each label means.
 *
 * THE PICTURES SAY WHAT THEY ARE. Each is the current UI rendered from the
 * app's code on a demo cast (site-frames.ts DEMO) and wears that label; a
 * claim the picture does not show carries a sentence saying so. The route is
 * the one drawing, labelled a diagram and drawn as boxes of text.
 */

export function statusPill(s: ClaimStatus): string {
  return `<span class="st st-${s}">${esc(status()[s].label)}</span>`
}

function legend(): string {
  const rows = (Object.keys(status()) as ClaimStatus[]).map((s) => `<div>${statusPill(s)}<span>${esc(status()[s].meaning)}</span></div>`)
  return `<div class="st-legend" id="status" aria-label="${tr('What the labels mean', '标签的含义')}">${rows.join('')}</div>`
}

function claim(c: Claim): string {
  return `<li class="claim" data-status="${c.status}">${statusPill(c.status)}<div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></li>`
}

/** The pillar's width on a 1440 desktop (the home body beside its contents list): what a full-width figure is drawn at. */
const PILLAR_MEDIA_PX = 940

function media(p: Pillar): string {
  return p.media
    .map((m) => {
      const span = m.span ?? 12
      return figure(DEMO[m.key], { cls: `span-${span}`, sizes: `(max-width: 860px) 100vw, ${Math.round((PILLAR_MEDIA_PX * span) / 12)}px` })
    })
    .join('')
}

/** The route as it is today, and the one hand-made experiment, as text in boxes: a diagram, never a screen. */
function routeDiagram(): string {
  const box = (title: string, sub: string, cls = ''): string => `<li class="${cls}"><b>${esc(title)}</b><span>${esc(sub)}</span></li>`
  return `<figure class="route-diagram" aria-label="${tr('Diagram of how a harness reaches a model', 'harness 如何连到模型的示意图')}">
<p class="route-row">${statusPill('shipped')} ${tr('on every machine', '每台机器上')}</p>
<ol>${box(tr('Agent card', 'Agent 卡片'), 'Claude Code · Codex · OpenCode · Pi')}${box(tr('Magpie, this machine', '本机的 Magpie'), tr('on loopback, run by you', '在本机回环地址上，由你运行'))}${box(tr('Your models', '你的模型'), tr('subscription · API key · local model', '订阅 · API key · 本地模型'))}</ol>
<p class="route-row">${statusPill('experiment')} ${tr('ssh tunnel, 12 Nov 2026 — not a product path', 'ssh 隧道，2026 年 11 月 12 日——不是产品路径')}</p>
<ol class="exp">${box(tr('Agent on machine A', '机器 A 上的 agent'), tr('its tools run on A', '它的工具在 A 上运行'))}${box(tr('Magpie on machine B', '机器 B 上的 Magpie'), tr('reached over ssh -L, by hand', '手动经 ssh -L 连接'), 'dashed')}${box(tr('B’s model', 'B 的模型'), tr('one model, one run', '一个模型，一次运行'))}</ol>
<figcaption>${tr('Diagram, not a screenshot.', '示意图，不是截图。')}</figcaption>
</figure>`
}

function pillar(p: Pillar, index: number): string {
  return `<section class="pillar" id="${p.id}"><div class="wrap">
<p class="kicker"><span class="no">0${index + 1}</span>${esc(p.kicker)}</p>
<h2>${esc(p.title)}</h2>
<p class="lede">${esc(p.lede)}</p>
<div class="pillar-body"><ul class="claims">${p.claims.map(claim).join('')}</ul>
<div class="pillar-media">${p.id === 'gateway' ? routeDiagram() : ''}${media(p)}</div></div>
</div></section>`
}

export function pillarsSection(): string {
  return `<section class="pillars-intro"><div class="wrap">${legend()}</div></section>
${pillars().map(pillar).join('\n')}`
}

export function roadmapSection(): string {
  return `<section id="roadmap"><div class="wrap">
<p class="kicker"><span class="no">${tr('ROADMAP', '路线图')}</span>${tr('a trusted room first', '先建一个可信的空间')}</p>
<h2>${tr('Where this is going', '接下来的方向')}</h2>
<ol class="roadmap">${roadmap().map((r) => `<li><div class="roadmap-head"><b>${esc(r.phase)}</b>${statusPill(r.status)}</div><ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></li>`).join('')}</ol>
</div></section>`
}
