import type { ListedDoor } from './site'
import { FRAMES, frameUrl, type Frame } from './site-frames'
import { GITHUB_REPO, esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'

/**
 * THE FRONT PAGE.
 *
 * The claim it opens with is the one the product actually makes, and it is a
 * comparison because that is how anybody arrives here: they already have a
 * chat tab, and the question is why they would want anything else. Every
 * feature after that is shown by a recorded case — a frame QA captured from
 * the running app with real input — rather than described.
 *
 * The download buttons name the release GitHub says is current; the directory
 * strip is computed from the relay's connection table on this request. Nothing
 * on this page is hand-maintained.
 */

export interface HomeInput {
  doors: readonly ListedDoor[]
  release: Release | null
  /** Star count for a door, from the star store. */
  stars: (handle: string, name: string) => number
}

interface Feature {
  no: string
  key: string
  title: string
  lede: string
  pts: string[]
  frames?: Frame[]
  cmd?: string
  cta?: string
  flip?: boolean
}

const FEATURES: Feature[] = [
  {
    no: '01',
    key: 'canvas',
    title: 'One canvas, three kinds of card',
    lede: 'Every black card is a real terminal running a real agent. Notes and browsers sit beside the agent they are about, and the wires are the org chart.',
    pts: [
      'Agent terminals with a name, a role and a live turn tracker',
      'Sticky notes for specs, reviews and handovers',
      'Connected browser cards that agents can drive',
      'Wires say who hands work to whom'
    ],
    frames: [FRAMES.task]
  },
  {
    no: '02',
    key: 'harness',
    title: 'Any harness. Mix them in one team.',
    lede: 'Claude Code, Codex, OpenCode, Pi and a plain shell ship in the dock. Add by link brings somebody else’s crew into your dock.',
    pts: [
      'Pick a preset, click the canvas, the teammate boots and its card opens',
      'One CLI for every harness, so orchestration does not care which one answers',
      'A new harness declares its capabilities in the registry; no call sites change'
    ],
    frames: [FRAMES.harness],
    flip: true
  },
  {
    no: '03',
    key: 'checkpoints',
    title: 'Every turn is a checkpoint',
    lede: 'Scrub back through a session, fork a new agent from any past turn, pin a version when a team is exported or called. Exporting or calling never touches the original session.',
    pts: [
      'The rail beside the live terminal lists every turn as it lands',
      'Hold to scrub: the turn list opens, version pins slide past, release to snap back to LIVE',
      'Fork from turn N; the original keeps running',
      'History trace: each checkpoint carries the block the agent actually produced'
    ],
    frames: [FRAMES.trace, FRAMES.rail]
  },
  {
    no: '04',
    key: 'board',
    title: 'Board: the whole fleet on one screen',
    lede: 'What each agent is doing, how many tokens it has spent, which checkpoint it is on. Notes, forks and session cards mix into one activity stream that can be replayed.',
    pts: [
      'active / unread / offline rows, per agent, per workspace',
      'Cross-workspace calls show up as what they are',
      'Not a log file: a team memory you can scrub'
    ],
    frames: [FRAMES.board],
    flip: true
  },
  {
    no: '05',
    key: 'cli',
    title: 'Orchestration is a command line',
    lede: 'People and agents share one CLI. Whatever you can type, the orchestrating agent can type too, which makes a commander leading a crew a native way to work.',
    pts: [
      'recruit, connect, ask, status, fork, team save, workspace create',
      'The turn tracker reports thinking / waiting / replied precisely, no scraping',
      'Saved teams snapshot nodes, wires and turn histories in one file'
    ],
    cmd: `$ cookrew list                      <span class="c"># who I am wired to</span>
$ cookrew ask "Tinker" "fix the socket singleton bug"
$ cookrew status                    <span class="c"># thinking / waiting / replied</span>
$ cookrew fork "Forge" --turn 40
$ cookrew team save "COOKREW CORE"
$ cookrew workspace create "New project" --team "COOKREW CORE"
$ cookrew recruit "Magpie" --preset "Claude Code" --role "QA"`
  },
  {
    no: '06',
    key: 'mobile',
    title: 'The phone companion',
    lede: 'cookrew mobile prints a QR code. Scan it on the same Wi-Fi or over Tailscale and the same canvas is in your pocket: tap a card for the full session, dictate a brief, hear the reply.',
    pts: [
      'Light mini-cards on the canvas so the phone never runs out of memory',
      'Voice in, spoken replies out',
      'Every workspace has a fixed slug URL, so a bookmark lands on its team',
      'Served teams can be imported from the phone too'
    ],
    frames: [FRAMES.mobile],
    flip: true
  },
  {
    no: '07',
    key: 'workspaces',
    title: 'A workspace is a garage: one project, one team',
    lede: 'Switching a workspace switches the whole team and the whole canvas. Create one from a saved template and a full crew is on duty at once.',
    pts: [
      'Named workspaces beside the session workspaces minted for callers',
      'workspace create --team puts a saved formation to work immediately',
      'One window per workspace is a flag the dev machine runs in production'
    ],
    frames: [FRAMES.workspaces]
  },
  {
    no: '08',
    key: 'market',
    title: 'Somebody else’s crew, working for you',
    lede: 'The marketplace lists doors, not copies. A team stays on its author’s machine; you sign in, pay per session if it is priced, and get a live sandboxed session of your own.',
    pts: [
      'One cookrew.dev link: served on the author’s side, opened on yours',
      'The relay carries bytes it cannot read; the author can end a session any time',
      '200 signed delivery · 401 passkey · 402 pay · 403 not covered — money goes straight to the author, this registry never holds it',
      'Each team has its own web line, the same PTY the placed card gets'
    ],
    frames: [FRAMES.market],
    cta: `<a class="btn primary" href="/market">Explore the marketplace →</a>`,
    flip: true
  }
]

function figure(frame: Frame, extra = ''): string {
  return `<figure class="shot"${extra}><img src="${esc(frameUrl(frame))}" alt="${esc(frame.alt)}" loading="lazy"><figcaption><span class="rec">● REC</span>${esc(frame.caption)}</figcaption></figure>`
}

function featureSection(f: Feature): string {
  const visual = f.cmd
    ? `<code class="cmd">${f.cmd}</code>`
    : (f.frames ?? []).map((fr, i) => figure(fr, i > 0 ? ' style="margin-top:18px"' : '')).join('')
  return `<section id="${f.key}"><div class="wrap feature${f.flip ? ' flip' : ''}">
<div class="text"><p class="kicker"><span class="no">${f.no}</span>${f.frames ? '<span class="chip rec-chip">✓ recorded</span>' : ''}</p>
<h2>${esc(f.title)}</h2><p class="lede" style="font-size:16px">${esc(f.lede)}</p>
<ul class="pts">${f.pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${f.cta ? `<p class="row">${f.cta}</p>` : ''}</div>
<div>${visual}</div></div></section>`
}

/** One line in a list of doors — the front page's directory strip. */
export function doorRow(door: ListedDoor, stars: number): string {
  const at = `/${esc(door.handle)}/${esc(door.name)}`
  const off = door.live === false
  return `<li>
<span class="led${off ? ' off' : ''}" title="${off ? 'offline' : 'taking calls'}"></span>
<div><a class="ttl" href="${at}">${esc(door.title)}</a> <span class="chip violet">${esc(door.door)} answers</span>
<div class="meta">by <a href="/${esc(door.handle)}">@${esc(door.handle)}</a> · one door: ${esc(door.door)} · ${door.agents} agent${door.agents === 1 ? '' : 's'} · ${off ? '<span class="off">offline</span>' : 'taking calls'} · via ${esc(door.transport)}</div></div>
<div class="row">${priceChip(door)}<a class="star" href="${at}#star">★ <span>${stars}</span></a></div>
</li>`
}

export function priceChip(door: ListedDoor): string {
  return door.access === 'paid' && door.priceUsd
    ? `<span class="price">${esc(door.priceUsd)} USD · per session</span>`
    : `<span class="price free">free · account needed</span>`
}

function downloadButtons(release: Release | null): string {
  if (!release) {
    return `<p class="row"><a class="btn primary lg" href="${RELEASES_PAGE}">⬇ Download from GitHub</a><a class="btn lg" href="${GITHUB_REPO}" target="_blank" rel="noopener">GitHub ↗</a></p>
<p class="meta">Release details are fetched from GitHub; they are not available right now.</p>`
  }
  const mac = pickAsset(release, 'mac')
  const win = pickAsset(release, 'windows')
  const date = release.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row">${mac ? `<a class="btn primary lg" href="${esc(mac.url)}">⬇ Download for macOS</a>` : ''}${win ? `<a class="btn lg" href="${esc(win.url)}">Windows preview</a>` : ''}<a class="btn lg" href="${GITHUB_REPO}" target="_blank" rel="noopener">GitHub ↗</a></p>
<p class="meta">v${esc(release.version)}${date ? ` · ${esc(date)}` : ''} · Apple Silicon · <a href="${esc(release.url)}">all builds</a></p>`
}

function downloadSection(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const mb = (bytes: number): string => (bytes > 0 ? ` · ${(bytes / 1048576).toFixed(0)} MB` : '')
  return `<section id="download"><div class="wrap">
<p class="kicker"><span class="no">GET IT</span>${release ? `v${esc(release.version)}` : 'latest'}</p>
<h2>Download Cookrew</h2>
<div class="dl">
<div class="card"><h3>macOS · Apple Silicon</h3>${mac ? `<a class="btn primary" href="${esc(mac.url)}">${esc(mac.name)}</a><small>${esc(release?.publishedAt.slice(0, 10) ?? '')}${mb(mac.bytes)}</small>` : `<a class="btn primary" href="${RELEASES_PAGE}">latest release ↗</a>`}</div>
<div class="card"><h3>Windows · preview</h3>${win ? `<a class="btn" href="${esc(win.url)}">${esc(win.name)}</a><small>Preview quality${mb(win.bytes)}</small>` : `<a class="btn" href="${RELEASES_PAGE}">latest release ↗</a>`}</div>
<div class="card"><h3>Build from source</h3><code class="cmd" style="margin:8px 0;font-size:14px">git clone ${GITHUB_REPO}
npm install &amp;&amp; npm run dev</code><small>Node 20+, tmux or herdr. <a href="${GITHUB_REPO}">Read the README ↗</a></small></div>
</div>
<p class="meta">Every team page also answers a <code>cookrew://</code> link, so a team you found on the web opens in the app you already have. <a href="/download">/download</a> sends you to the build for your platform.</p>
</div></section>`
}

export function homePage(input: HomeInput): Page {
  const { doors, release } = input
  // Counted the same way, for the same reason: the heading and the rows under
  // it are one answer, and an offline team is not "serving right now".
  const serving = doors.filter((d) => d.live !== false).length
  const live =
    doors.length === 0
      ? `<p class="empty">Nobody is serving a team here yet.</p>`
      : `<ul class="doors">${doors
          .slice(0, 8)
          .map((d) => doorRow(d, input.stars(d.handle, d.name)))
          .join('')}</ul>`

  return page(
    { title: 'Cookrew — a team of AI agents on one canvas', kind: 'document', active: 'home' },
    `
<div class="hero"><div class="wrap">
<div><span class="tagline">OPEN SOURCE · MAC &amp; WINDOWS PREVIEW</span>
<h1>A chat tab gives you one assistant.<br>Cookrew gives you a team.</h1>
<p class="lede">Put Claude Code, Codex, OpenCode and Pi on one canvas. Wire them together, give them roles, and watch the whole crew work. Then pack the team up, copy it, or serve it to someone else at a cookrew.dev address.</p>
${downloadButtons(release)}</div>
<div>${figure(FRAMES.canvas)}</div>
</div></div>

${FEATURES.map(featureSection).join('\n')}

<section id="serving"><div class="wrap">
<p class="kicker"><span class="no">LIVE</span>from the directory</p>
<h2>Serving right now${serving > 0 ? ` · ${serving}` : ''}</h2>
<p class="lede" style="font-size:16px">Teams somebody is holding a door open for. A team stays on its author’s machine. You sign in with a passkey, pay per session if it is priced, and get a live sandboxed session of your own — the author can end it at any time. Money goes from the caller straight to the author; this registry never holds it.</p>
${live}
<p class="row" style="margin-top:18px"><a class="btn primary" href="/market">Explore all teams →</a><span class="meta">Serve yours: save a team in the app, press SERVE, and it is listed at cookrew.dev/@you/&lt;team&gt;.</span></p>
</div></section>

<section id="proof"><div class="wrap">
<p class="kicker"><span class="no">PROOF</span>Cookrew is built by itself</p>
<h2>The hardest evidence</h2>
<p class="lede" style="font-size:16px">Every frame on this page comes from the canvas where a crew of agents develops Cookrew: Forge writes features, Tinker fixes bugs, Magpie runs QA, Conductor directs, independent agents audit and report. The frames were captured by one of them.</p>
<div class="note" style="max-width:560px"><b>Three promises.</b> Your original session is never touched. Pay once, fetch again free. Money goes straight to the author; Cookrew takes nothing.</div>
</div></section>

${downloadSection(release)}`
  )
}
