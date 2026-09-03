import { esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import { DEFINITION, FACTS, GITHUB_REPO } from './site-content'
import { breadcrumbs, faqPage, organization, webPage } from './site-seo'

/**
 * GET STARTED — the page for "how do I install cookrew" and "how do I make my
 * first team", plus the crew builder: pick harnesses and roles, get the exact
 * commands. The commands need the app, which is the point: reading became
 * doing, and doing needs an install. An app page, because the builder is a
 * few lines of script; everything else on it is plain HTML.
 */

const HOWTO = [
  { name: 'Install Cookrew', text: 'Download the build for your platform, or clone the repository and run npm install && npm run dev. Cookrew needs Node 20 or newer and tmux or herdr to host terminals.' },
  { name: 'Place your first agent', text: 'Pick a preset in the dock — Claude Code, Codex, OpenCode, Pi or Shell — and click the canvas. The teammate boots in its own terminal and the card opens.' },
  { name: 'Recruit a crew from the CLI', text: 'From any terminal: cookrew recruit "Forge" --preset "Claude Code" --role "builder", then cookrew connect to wire teammates, and cookrew orch to name the door.' },
  { name: 'Ask, and read the reply', text: 'cookrew ask "Forge" "…" waits for the turn to end and returns the reply; cookrew status reports thinking, waiting, replied or idle. Every turn lands on the card’s rail as a checkpoint.' },
  { name: 'Save the team', text: 'cookrew team save "MY CREW" snapshots nodes, wires and turn histories. cookrew workspace create "New project" --team "MY CREW" puts the formation to work in a new directory.' },
  { name: 'Serve it, or open someone’s', text: 'SERVE lists a saved team at cookrew.dev/@you/team; anyone with the link opens a sandboxed session from a browser or the app. Or paste an address into Import a team, or click Open in Cookrew on a team page.' }
]

const START_FAQ = [
  { q: 'What do I need before installing Cookrew?', a: 'A Mac with Apple Silicon or Windows (preview), Node 20+ if you build from source, tmux or herdr to host terminals, and the agent CLIs you want to run (Claude Code, Codex, OpenCode, Pi) with their own logins.' },
  { q: 'Do I need an account to use Cookrew?', a: 'No. The app runs entirely on your machine. A cookrew.dev account is needed only to serve a team on the marketplace or to open someone else’s.' },
  { q: 'How do I open a team someone shared?', a: 'Click Open in Cookrew on its team page, or paste the address (cookrew.dev/@handle/team) into Cookrew → Import a team. The app shows the team’s face and asks before placing the card.' }
]

export function startPage(release: Release | null): Page {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  return page(
    {
      title: 'Get started with Cookrew — install, place your first agent, build a crew',
      kind: 'app',
      active: 'start',
      scripts: ['site.js'],
      description: 'Install Cookrew on macOS or Windows, place your first agent from the dock, recruit a crew from the CLI, save the team, and serve it at cookrew.dev — with a crew builder that writes the commands for you.',
      path: '/start',
      jsonLd: [
        organization(),
        webPage({ path: '/start', name: 'Get started with Cookrew', description: DEFINITION }),
        breadcrumbs([{ name: 'Cookrew', path: '/' }, { name: 'Get started', path: '/start' }]),
        {
          '@type': 'HowTo',
          name: 'Get started with Cookrew',
          description: 'Install Cookrew and run your first team of AI coding agents.',
          step: HOWTO.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text }))
        },
        faqPage(START_FAQ)
      ]
    },
    `<div class="wrap" style="padding-top:44px">
<p class="kicker"><span class="no">START</span>ten minutes to a working crew</p>
<h1>Get started with Cookrew</h1>
<p class="lede">${esc(DEFINITION)}</p>
<p class="row">${mac ? `<a class="btn primary lg" href="${esc(mac.url)}">⬇ Download for macOS</a>` : `<a class="btn primary lg" href="${RELEASES_PAGE}">Latest release ↗</a>`}${win ? `<a class="btn lg" href="${esc(win.url)}">Windows preview</a>` : ''}<a class="btn lg" href="${GITHUB_REPO}" target="_blank" rel="noopener">Source ↗</a></p>
<p class="meta">${release ? `v${esc(release.version)} · ${esc(release.publishedAt.slice(0, 10))}` : ''} · ${FACTS.license} · Node 20+ · tmux or herdr</p>

<h2>Six steps</h2>
<ol class="howto">${HOWTO.map((s) => `<li><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></li>`).join('')}</ol>

<h2 id="build">Build your crew</h2>
<p>Pick the harnesses and give each a role. The commands below are exactly what you paste into a terminal after Cookrew is running; the orchestrator is the door a served team answers through.</p>
<div class="card soft" id="crew-builder">
<div class="filters" id="crew-harnesses">${FACTS.harnesses.filter((h) => h !== 'Shell').map((h) => `<label><input type="checkbox" name="h" value="${esc(h)}"${h === 'Claude Code' ? ' checked' : ''}><span class="chip">${esc(h)}</span></label>`).join('')}</div>
<div class="row" style="margin-top:12px"><label class="meta">Roles, comma separated <input id="crew-roles" value="builder, reviewer" style="font:13px var(--font-mono);padding:6px 8px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink);min-width:240px"></label><label class="meta"><input type="checkbox" id="crew-orch" checked> the first one is the orchestrator</label></div>
<code class="cmd" id="crew-script">$ cookrew recruit "Forge" --preset "Claude Code" --role "builder"
$ cookrew recruit "Bench" --preset "Claude Code" --role "reviewer"
$ cookrew connect "Forge" "Bench"
$ cookrew orch "Forge"</code>
<p class="row"><button class="btn primary" id="crew-copy">Copy the commands</button><span class="meta" id="crew-note">Names are placeholders; rename them on the canvas.</span></p>
</div>

<h2 id="serve">Serve a team at cookrew.dev</h2>
<ol class="howto">
<li><h3>Save the team</h3><p>Select the cards, name the team, save. A saved team is nodes, wires and turn histories in one file; the original session is never touched.</p></li>
<li><h3>Press SERVE and write the face</h3><p>Choose free or priced, add a one-sentence summary and a few tags. The harness names behind the door are derived from the roster; the roster itself is never listed.</p></li>
<li><h3>Sign the registration</h3><p>Your cookrew.dev account signs it; the registry lists the address verbatim and marks the team live only while your relay connection is up.</p></li>
<li><h3>Share the address</h3><p>cookrew.dev/@you/team works in a browser (the team’s own terminal) and in the app (the card with its rail). You can end any caller’s session at any time.</p></li>
</ol>

<section id="faq" style="border:none;padding:24px 0 0"><h2>Questions</h2><div class="faq">${START_FAQ.map((f) => `<details open><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>
</div>`
  )
}
