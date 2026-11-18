import { DEMO, figure } from './site-frames'
import { esc } from './site-shell'
import { pillars, type Claim, type Pillar } from './site-content'
import { tr } from './site-lang'

/**
 * THE THREE PILLARS — the front page's argument, drawn from site-content.ts.
 * Owner 2026-11-18: no status labels, legend or roadmap on the page; a pillar
 * shows only what the released app does (site-content.ts pillars()).
 *
 * The pictures are the current UI rendered from the app's code on a demo cast
 * (site-frames.ts DEMO). The route is the one drawing, drawn as boxes of text.
 */

function claim(c: Claim): string {
  return `<li class="claim"><div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div></li>`
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

/** The route on a machine, as text in boxes: a diagram, never a screen. */
function routeDiagram(): string {
  const box = (title: string, sub: string, cls = ''): string => `<li class="${cls}"><b>${esc(title)}</b><span>${esc(sub)}</span></li>`
  return `<figure class="route-diagram" aria-label="${tr('Diagram of how a harness reaches a model', 'harness 如何连到模型的示意图')}">
<ol>${box(tr('Agent card', 'Agent 卡片'), 'Claude Code · Codex · OpenCode · Pi')}${box(tr('Magpie, this machine', '本机的 Magpie'), tr('on loopback, run by you', '在本机回环地址上，由你运行'))}${box(tr('Your models', '你的模型'), tr('subscription · API key · local model', '订阅 · API key · 本地模型'))}</ol>
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
  return pillars().map(pillar).join('\n')
}
