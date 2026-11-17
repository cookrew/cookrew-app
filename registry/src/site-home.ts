import type { Commit } from './github-commits'
import { esc, icon, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import { definition, FACTS, faq, headline, headlineSub, pillars, startFaq, startHowto } from './site-content'
import { currentLang, local, tr } from './site-lang'
import { commitsSection, compareTable, featuresGrid } from './site-features'
import { faqPage, organization, softwareApplication, webPage } from './site-seo'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML } from './site-brand'
import { DEMO, figure } from './site-frames'
import { pillarsSection, roadmapSection } from './site-pillars'

/**
 * THE FRONT PAGE OF THE STATIC SITE (0.6.0, site-static.ts) — one page, top to
 * bottom: the hero (the claim, the download, the way to the console and the
 * hero clip), the three pillars (site-pillars.ts: every claim with its
 * status, and pictures of the current UI on demo data), the roadmap, GET STARTED (the two steps and the commands the
 * orch runs) and the FEATURES (every one as a card, the comparison, the
 * questions, the commits). The page's sections are
 * its catalog, on the right rail. A feature's own page (/features/<slug>) is
 * the long tail, and the cards lead there.
 *
 * NO MARKETPLACE: nothing here is served by a registry, so nothing here lists
 * what one is serving. The way to "your machines" is the console.
 *
 * A DOCUMENT page: no script, no form, no handler. So the commands the crew
 * builder would write are shown as they are, which is what a reader pastes.
 */

/** The definition's first sentence: enough to quote, short enough to read. */
const oneLine = (): string => { const d = definition(); const end = currentLang() === 'zh' ? d.indexOf('。') + 1 : d.indexOf('. ') + 1; return d.slice(0, end) }
const description = (): string => (currentLang() === 'zh' ? definition().slice(0, 80) + '…' : definition().slice(0, 157).replace(/\s+\S*$/, '') + '…')

/**
 * THE HERO (2026-11-17): one agent's question on three devices, a composite of
 * three renders on demo data (site-frames.ts DEMO.hero), labelled as such, the
 * full width of the page under the headline (it was a 470 px column beside it).
 * The twenty-second clip that stood here is on the canvas feature page.
 */
function hero(): string {
  return figure(DEMO.hero, { eager: true, sizes: '(max-width: 860px) 100vw, 940px' })
}

/** GET STARTED: the two steps, the crew builder, and the two questions people ask first. */
function startSection(): string {
  return `<section id="start"><div class="wrap">
<p class="kicker"><span class="no">${tr('START', '开始')}</span>${tr('two steps to a working crew', '两步组建一个能干活的团队')}</p>
<h2>${tr('Get started', '开始使用')}</h2>
<ol class="howto two">${startHowto().map((s, i) => `<li${i === 1 ? ' id="serve"' : ''}><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p><ul class="pts">${s.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></li>`).join('')}</ol>

<h3 id="build" style="margin-top:26px">${tr('What your orch runs', '你的编排者运行的命令')}</h3>
<p>${tr(`These are the commands the orchestrator runs when you ask it for teammates — or paste them yourself into any terminal with Cookrew running. Any of ${esc(FACTS.harnesses.filter((h) => h !== 'Shell').join(', '))} goes after <code>--preset</code>.`, `这些是你让编排者招募队友时它运行的命令——你也可以把它们粘贴到任何运行着 Cookrew 的终端里。<code>--preset</code> 后面可以填 ${esc(FACTS.harnesses.filter((h) => h !== 'Shell').join('、'))} 中的任何一个。`)}</p>
<div class="card soft" id="crew-commands">
<code class="cmd">$ cookrew recruit "Forge" --preset "Claude Code" --role "builder"
$ cookrew recruit "Bench" --preset "Codex" --role "reviewer"
$ cookrew connect "Forge" "Bench"
$ cookrew orch "Forge"</code>
<p class="meta" style="margin:10px 0 0">${tr('Names are placeholders; rename them on the canvas. The first one is the orchestrator.', '名字只是占位符，可以在画布上改名。第一个是编排者。')}</p>
</div>
<div class="faq" style="margin-top:18px">${startFaq().map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</div></section>`
}

/** FEATURES: every one as a card, then what each thing can do, the questions, the proof. */
function featuresSection(commits: readonly Commit[] | null): string {
  return `<section id="features"><div class="wrap">
<p class="kicker"><span class="no">${tr('FEATURES', '功能')}</span>${tr('what each part does', '每个部分做什么')}</p>
<h2>${tr('What Cookrew does', 'Cookrew 能做什么')}</h2>
<p class="lede">${esc(definition())}</p>
${featuresGrid()}
<h3 id="compare" style="margin-top:32px">${tr('A chat tab, one CLI agent, or a team', '聊天标签页、单个 CLI agent，还是一个团队')}</h3>${compareTable()}
<h3 id="faq" style="margin-top:32px">${tr('Questions and answers', '常见问题')}</h3><div class="faq">${faq().map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</div></section>
${commitsSection(commits)}`
}

export interface StaticHomeInput {
  release: Release | null
  commits?: readonly Commit[] | null
  /** The console's origin. */
  console: string
}

function staticHeroButtons(release: Release | null, console: string): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row" id="download"><a class="btn primary lg" href="${esc(mac?.url ?? release?.url ?? RELEASES_PAGE)}">${icon('download')} ${tr('Download for Mac', '下载 Mac 版')}</a><a class="btn lg" href="${esc(console)}/">${icon('mac')} ${tr('Open console', '打开控制台')}</a></p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">${tr('latest release', '最新版本')}</a>`} · ${FACTS.license} · Apple Silicon${win ? ` · <a href="${esc(win.url)}">${tr('Windows preview', 'Windows 预览版')}</a>` : tr(', Windows preview', '，Windows 预览版')}</p>`
}

/** The three pillars, one link each: the page's argument in one row. */
function staticDock(): string {
  const icons = { everywhere: 'mac', gateway: 'canvas', workspace: 'play' } as const
  return `<nav class="dock compact" aria-label="${tr('The three parts of Cookrew', 'Cookrew 的三个部分')}">
${pillars().map((p) => `<a href="#${p.id}"><span class="ico">${icon(icons[p.id])}</span><span><span class="t">${esc(p.title)}</span></span></a>`).join('\n')}
</nav>`
}

function staticCatalog(console: string, built: boolean): string {
  const listed: [string, string, boolean][] = [
    ['#status', tr('What is shipped', '已上线的内容'), false],
    ...pillars().map((p): [string, string, boolean] => [`#${p.id}`, p.title, true]),
    ['#roadmap', tr('Roadmap', '路线图'), true],
    ['#start', tr('Get started', '开始使用'), false],
    ['#serve', tr('Save the team', '保存团队'), true],
    ['#build', tr('What your orch runs', '编排者运行的命令'), true],
    ['#features', tr('Features', '功能'), false],
    ['#compare', tr('Chat tab, one agent, or a team', '聊天、单个 agent 还是团队'), true],
    ['#faq', tr('Questions', '常见问题'), true],
    ['#built', tr('What landed on dev', 'dev 分支的最新提交'), true]
  ]
  // The list of commits is on the page only when GitHub was read at build time.
  const items = listed.filter(([href]) => built || href !== '#built')
  return `<aside class="toc" aria-label="${tr('On this page', '本页内容')}">
<div class="jump"><a class="btn sm primary" href="#download">${icon('download')} ${tr('Get the app', '获取应用')}</a><a class="btn sm" href="${esc(console)}/">${icon('mac')} ${tr('Open console', '打开控制台')}</a></div>
<p class="kicker"><span class="no">${tr('ON THIS PAGE', '本页内容')}</span></p><ol>${items
    .map(([href, label, sub]) => `<li${sub ? ' class="sub"' : ''}><a href="${href}">${esc(label)}</a></li>`)
    .join('')}</ol></aside>`
}

export function staticHomePage(input: StaticHomeInput): Page {
  return page(
    {
      title: tr('Cookrew — AI coding agents on every machine, one account', 'Cookrew —— 一个账号，管理每台机器上的 AI 编程 agent'),
      kind: 'document',
      active: 'home',
      description: description(),
      path: local('/'),
      jsonLd: [
        organization(),
        softwareApplication(input.release),
        webPage({ path: local('/'), name: 'Cookrew', description: definition() }),
        {
          '@type': 'HowTo',
          name: tr('Get started with Cookrew', '开始使用 Cookrew'),
          description: tr('Place an agent and let it orchestrate your workflow; save the team and start your next project with it.', '放一个 agent，让它编排你的工作流；保存团队，用它开始下一个项目。'),
          step: startHowto().map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text }))
        },
        faqPage([...startFaq(), ...faq()])
      ]
    },
    `<div class="wrap home">
<div class="home-body">
<style>${BRAND_LOCKUP_CSS}</style>
<div class="hero"><div class="wrap">
<div class="hero-text"><div>${BRAND_LOCKUP_HTML}<span class="tagline">${tr('OPEN SOURCE', '开源')} · ${FACTS.license} · ${FACTS.harnesses.slice(0, 4).join(' · ').toUpperCase()}</span>
<h1>${esc(headline())}</h1></div>
<div><p class="hero-sub">${esc(headlineSub())}</p>
<p class="lede">${esc(oneLine())} ${tr('Follow and answer them from the desktop or any browser.', '在桌面或任何浏览器里跟进并回复它们。')}</p>
${staticHeroButtons(input.release, input.console)}</div></div>
${hero()}
</div></div>

<div class="wrap" style="padding:0">${staticDock()}</div>

${pillarsSection()}

${roadmapSection()}

${startSection()}

${featuresSection(input.commits ?? null)}
</div>
${staticCatalog(input.console, (input.commits?.length ?? 0) > 0)}
</div>`
  )
}
