/**
 * THE WORDS — every sentence cookrew.dev says about itself, in one place.
 *
 * FIRST PRINCIPLE: a search engine ranks a page for a question it answers, an
 * answer engine quotes a sentence that survives being lifted alone, and a
 * person stays on a page where something real is happening. So the site's
 * copy is written as definitions first (what X IS), facts with dates, and
 * questions with one-paragraph answers — and the same sentences appear in
 * the HTML, in the JSON-LD, and in llms.txt, so every reader gets one story.
 *
 * Nothing here is a claim about the future. Every number carries its date.
 */

export const SITE_NAME = 'Cookrew'
export const SITE_ORIGIN = 'https://cookrew.dev'
export const GITHUB_REPO = 'https://github.com/cookrew/cookrew-app'

/** The one-sentence entity definition. Meta description, JSON-LD, llms.txt, the hero. */
export const DEFINITION =
  'Cookrew is an open-source desktop workspace for running a team of AI coding agents on one canvas. It runs Claude Code, Codex, OpenCode and Pi side by side, records every agent turn as a checkpoint, and can serve a saved team at a cookrew.dev address where anyone can open a live session from a browser or from the Cookrew app.'

export const HEADLINE = 'Run a team of AI coding agents on one canvas — or rent someone’s.'

export const MARKET_DEFINITION =
  'The Cookrew marketplace lists served teams: teams of AI agents that stay on their author’s machine. A caller signs in with a cookrew.dev account, pays per session if the team is priced, and gets a sandboxed session of their own. The relay carries encrypted bytes it cannot read; money goes directly from caller to author and cookrew.dev takes no cut.'

export const CHECKPOINT_DEFINITION =
  'In Cookrew every agent turn is a checkpoint. You can scrub back through a session, fork a new agent from any past turn, and pin a version when a team is exported or called. Exporting or calling never touches the original session.'

/** Dated facts. The date is part of the fact; an undated number is a rumour. */
export const FACTS = {
  testsGreen: { value: '4,975', date: '2026-09-03', note: 'vitest, full suite on the dev branch' },
  license: 'MIT',
  harnesses: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell'],
  platforms: ['macOS (Apple Silicon)', 'Windows (preview)'],
  relayCipher: 'X25519 → HKDF-SHA256 → AES-256-GCM',
  builtBy: 'a crew of 20+ agents on its own canvas'
} as const

export interface Faq {
  q: string
  a: string
}

export const FAQ: Faq[] = [
  { q: 'What is Cookrew?', a: DEFINITION },
  {
    q: 'Is Cookrew free and open source?',
    a: `Yes. Cookrew is ${FACTS.license}-licensed and developed in the open at ${GITHUB_REPO}. The desktop app is free. Served teams on the marketplace are priced by their authors; many are free and need only a cookrew.dev account.`
  },
  {
    q: 'Which AI coding agents does Cookrew run?',
    a: 'Claude Code, Codex, OpenCode and Pi ship as presets, plus a plain shell. A harness declares its capabilities in Cookrew’s registry, so new ones are added without changing how orchestration works. Any mix of them can work in one team.'
  },
  {
    q: 'Can I run Claude Code and Codex together?',
    a: 'Yes. Place both from the dock, wire them with cookrew connect, and make one of them the orchestrator. Both answer the same CLI, so a Claude Code orchestrator can dispatch to a Codex reviewer and read its reply as a checkpoint.'
  },
  {
    q: 'Do I need my own API keys?',
    a: 'Each harness uses its own login or key on your machine, exactly as it does in a terminal. Cookrew adds none of its own and never sees them. Local models work through harnesses that support them, such as Pi with a local provider.'
  },
  { q: 'What is the Cookrew marketplace?', a: MARKET_DEFINITION },
  {
    q: 'What does “serving a team” mean?',
    a: 'Serving publishes a saved team at cookrew.dev/@you/team-name. The team keeps running on your machine; each caller gets a sandboxed session workspace minted for them, which you can end at any time. The registry lists the address and marks it live only while your relay connection is up.'
  },
  {
    q: 'How much does a session cost, and who gets the money?',
    a: 'The author sets the price, charged once when a session starts and never per question. Card payments go through the author’s own Stripe checkout; USDC payments use x402. cookrew.dev holds none of it and takes nothing.'
  },
  {
    q: 'Is my code sent to cookrew.dev?',
    a: `No. A served session runs on the author’s machine inside a sandbox. Between a caller and a door, every byte is sealed in the caller’s browser or app (${FACTS.relayCipher}) to the door’s key; the relay moves ciphertext it cannot read. Your own local canvas never touches cookrew.dev unless you serve a team.`
  },
  {
    q: 'Can I use a team from a browser or from my phone?',
    a: 'Yes. Every team page on cookrew.dev carries the team’s own terminal, the same PTY a placed card gets, drawn in the browser. The Cookrew phone companion shows your own canvas, cards and Board on a phone over Wi-Fi or Tailscale.'
  },
  { q: 'What is a checkpoint?', a: CHECKPOINT_DEFINITION },
  {
    q: 'How do I install a team from a link?',
    a: 'Click “Open in Cookrew” on a team page, or paste the address into Cookrew → Import a team. The app shows the team’s face first and asks before placing anything; a link on its own never installs.'
  }
]

export interface CompareRow {
  question: string
  chat: string
  singleAgent: string
  cookrew: string
}

/** The comparison people search for. Every cell is a fact about today's product. */
export const COMPARE: CompareRow[] = [
  { question: 'How many agents work at once?', chat: 'One assistant', singleAgent: 'One CLI agent per terminal', cookrew: 'A team on one canvas, wired together' },
  { question: 'Can agents hand work to each other?', chat: 'No', singleAgent: 'Sub-agents inside one harness', cookrew: 'Any harness dispatches to any other over one CLI' },
  { question: 'Can you go back to an earlier turn?', chat: 'Scroll up', singleAgent: 'Rewind in some harnesses', cookrew: 'Every turn is a checkpoint; fork an agent from any of them' },
  { question: 'Can you see the whole team’s state?', chat: 'No', singleAgent: 'One terminal at a time', cookrew: 'The Board: phase, tokens and checkpoint per agent' },
  { question: 'Can you save and reuse a team?', chat: 'No', singleAgent: 'Config files', cookrew: 'Save a team; create a workspace from it in one command' },
  { question: 'Can someone else use your team?', chat: 'Share a prompt', singleAgent: 'Share a repo', cookrew: 'Serve it at cookrew.dev; they get a live sandboxed session' },
  { question: 'Works from a phone?', chat: 'Yes', singleAgent: 'No', cookrew: 'The companion: canvas, cards, Board, voice' }
]

export interface FeatureSpec {
  slug: string
  /** Intent-shaped title — what somebody types into a search box. */
  title: string
  short: string
  definition: string
  pts: string[]
  /** Frame keys from site-frames.ts (overview) — detailed step sequences are added from sequences. */
  frames: string[]
  faq: Faq[]
  related: string[]
}

export const FEATURES: FeatureSpec[] = [
  {
    slug: 'canvas',
    title: 'A spatial canvas for AI agents: terminals, notes and browsers',
    short: 'Every black card is a real terminal running a real agent. Notes and browsers sit beside the agent they are about, and the wires are the org chart.',
    definition:
      'The Cookrew canvas is an infinite spatial workspace where each agent is a card with a live terminal, a name, a role and a turn tracker; sticky notes hold specs and handovers; browser cards are real Chromium tabs an agent can drive; and wires between cards say who hands work to whom.',
    pts: ['Agent terminals with a name, a role and a live turn tracker', 'Sticky notes for specs, reviews and handovers', 'Connected browser cards that agents can drive', 'Wires say who hands work to whom, and who reviews whom'],
    frames: ['canvas', 'task'],
    faq: [
      { q: 'Is the terminal on a card a real terminal?', a: 'Yes. Each card is a PTY hosted by tmux or herdr, running the harness’s own CLI. What you see is what the agent sees.' },
      { q: 'Can an agent use a browser card?', a: 'Yes. Browser cards are Chromium pages driven over the DevTools protocol; an agent can navigate, click, fill and read them with the cookrew browser commands.' }
    ],
    related: ['harnesses', 'checkpoints', 'board']
  },
  {
    slug: 'harnesses',
    title: 'Run Claude Code, Codex, OpenCode and Pi in one team',
    short: 'Claude Code, Codex, OpenCode, Pi and a plain shell ship in the dock. Add by link brings somebody else’s crew into your dock.',
    definition:
      'A harness is an agent CLI Cookrew knows how to host, watch and dispatch to. Claude Code, Codex, OpenCode and Pi ship as presets; each declares its capabilities in Cookrew’s registry, so orchestration is the same command line whatever answers.',
    pts: ['Pick a preset, click the canvas, the teammate boots and its card opens', 'One CLI for every harness; the orchestrator does not care which one answers', 'The turn tracker reports thinking, waiting and replied from the harness itself, no scraping', 'Add by link puts a team someone else serves into your dock'],
    frames: ['harness'],
    faq: [
      { q: 'Can I add a harness Cookrew does not ship?', a: 'A harness is a registry entry that declares how it starts, how its turns are detected and what it can do. New ones are added there without touching call sites.' }
    ],
    related: ['canvas', 'cli', 'marketplace']
  },
  {
    slug: 'checkpoints',
    title: 'Every agent turn is a checkpoint: scrub, fork, pin',
    short: 'Scrub back through a session, fork a new agent from any past turn, pin a version when a team is exported or called.',
    definition: CHECKPOINT_DEFINITION,
    pts: ['The rail beside the live terminal lists every turn as it lands', 'Hold to scrub: the turn list opens, version pins slide past, release to snap back to LIVE', 'Fork from turn N; the original keeps running', 'History trace: each checkpoint carries the block the agent actually produced'],
    frames: ['trace', 'rail'],
    faq: [
      { q: 'What happens to my session when I fork or export?', a: 'Nothing. Forking, exporting and serving all copy from a checkpoint; the original session is never touched.' },
      { q: 'Where do checkpoints come from?', a: 'From the harness’s own session record: Cookrew reads the transcript the agent writes, so a checkpoint is the turn as the agent saw it, not a scrape of the screen.' }
    ],
    related: ['canvas', 'board', 'marketplace']
  },
  {
    slug: 'board',
    title: 'The Board: every agent’s phase, tokens and checkpoint on one screen',
    short: 'What each agent is doing, how many tokens it has spent, which checkpoint it is on. Notes, forks and session cards mix into one activity stream.',
    definition:
      'The Board is Cookrew’s fleet view: one row per agent across workspaces with its phase (working, waiting, unread, offline), token use and latest checkpoint, filterable by preset and role, with notes, forks and session cards folded into a searchable activity stream.',
    pts: ['active, unread and offline rows, per agent, per workspace', 'Facet chips by preset and role; search narrows the rows', 'Cross-workspace calls show up as what they are', 'Not a log file: a team memory you can scrub'],
    frames: ['board'],
    faq: [{ q: 'Does the Board work for offline agents?', a: 'Yes. An agent with no live pane shows as offline with its last checkpoint; its history is still there.' }],
    related: ['checkpoints', 'workspaces']
  },
  {
    slug: 'cli',
    title: 'Orchestrate coding agents from one command line',
    short: 'People and agents share one CLI. Whatever you can type, the orchestrating agent can type too.',
    definition:
      'The cookrew CLI is the one interface for people and agents alike: recruit a teammate, connect two cards, ask an agent and wait for its reply, read its status, fork it from a turn, save a team, create a workspace from a template. An orchestrating agent runs the same commands you do.',
    pts: ['recruit, connect, ask, status, fork, team save, workspace create', 'ask waits for the reply and returns it; status is thinking, waiting, replied or idle', 'Saved teams snapshot nodes, wires and turn histories in one file', 'The same CLI works from the phone companion and from a served session'],
    frames: [],
    faq: [{ q: 'Can an agent orchestrate other agents?', a: 'Yes. Make an agent the workspace’s orch; it can recruit, connect, ask and read status exactly as a person can, which is what makes a commander leading a crew a native way to work.' }],
    related: ['harnesses', 'workspaces']
  },
  {
    slug: 'mobile',
    title: 'The phone companion: your canvas, cards and Board on a phone',
    short: 'Scan a QR code and the same canvas is in your pocket: tap a card for the full session, dictate a brief, hear the reply.',
    definition:
      'The Cookrew phone companion is the same workspace served to a phone over Wi-Fi or Tailscale: light mini-cards on the canvas, a full session view per card with its rail, the Board, voice input and spoken replies, and a fixed slug URL per workspace for a bookmark.',
    pts: ['cookrew mobile prints the QR code; scan it and you are in', 'Light mini-cards so the phone never runs out of memory', 'Voice in, spoken replies out', 'Served teams can be imported from the phone too'],
    frames: ['mobile'],
    faq: [{ q: 'Does the phone need the app installed?', a: 'No. The companion is a web page served by your desktop app; a paired phone opens it in any browser.' }],
    related: ['canvas', 'board']
  },
  {
    slug: 'workspaces',
    title: 'Workspaces and saved teams: one project, one crew',
    short: 'Switching a workspace switches the whole team and the whole canvas. Create one from a saved template and a full crew is on duty at once.',
    definition:
      'A Cookrew workspace is a project directory with its own canvas, team and history. A saved team is a template of nodes, wires and turn histories; cookrew workspace create --team puts a saved formation to work in a new directory immediately.',
    pts: ['Named workspaces beside the session workspaces minted for callers', 'workspace create --team puts a saved formation to work immediately', 'One window per workspace is a flag the dev machine runs in production'],
    frames: ['workspaces'],
    faq: [{ q: 'What is a session workspace?', a: 'A workspace minted for one caller of a served team, sandboxed, and destroyed when the session ends, by the caller or by you.' }],
    related: ['cli', 'marketplace']
  },
  {
    slug: 'marketplace',
    title: 'The agent team marketplace: open someone’s crew from a browser',
    short: 'The marketplace lists doors, not copies. A team stays on its author’s machine; you sign in, pay per session if it is priced, and get a live sandboxed session of your own.',
    definition: MARKET_DEFINITION,
    pts: ['One cookrew.dev link: served on the author’s side, opened on yours', 'The relay carries bytes it cannot read; the author can end a session any time', '200 signed delivery · 401 sign in · 402 pay · 403 not covered — money goes straight to the author', 'Each team page carries the team’s own terminal, the same PTY the placed card gets'],
    frames: ['market'],
    faq: [
      { q: 'Can the team’s author see what I type?', a: 'The session runs on their machine, so the agents you talk to run there; the author can end the session but the relay in between reads nothing.' },
      { q: 'What can a served team access on my computer?', a: 'Nothing. It runs on the author’s machine in a sandbox; your browser or app only carries keystrokes and screen bytes.' }
    ],
    related: ['harnesses', 'checkpoints', 'workspaces']
  }
]

/** Everything a crawler or a model needs, as plain text: /llms.txt. */
export function llmsText(): string {
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${DEFINITION}`,
    '',
    `- Website: ${SITE_ORIGIN}`,
    `- Source: ${GITHUB_REPO} (${FACTS.license})`,
    `- Marketplace of served agent teams: ${SITE_ORIGIN}/market`,
    `- Getting started: ${SITE_ORIGIN}/start`,
    `- Features: ${FEATURES.map((f) => `${SITE_ORIGIN}/features/${f.slug}`).join(', ')}`,
    '',
    '## Definitions',
    '',
    `- Marketplace: ${MARKET_DEFINITION}`,
    `- Checkpoint: ${CHECKPOINT_DEFINITION}`,
    '',
    '## Facts',
    '',
    `- Harnesses: ${FACTS.harnesses.join(', ')}`,
    `- Platforms: ${FACTS.platforms.join(', ')}`,
    `- Tests green: ${FACTS.testsGreen.value} (${FACTS.testsGreen.date}, ${FACTS.testsGreen.note})`,
    `- Relay cipher: ${FACTS.relayCipher}; the relay reads nothing`,
    '',
    '## FAQ',
    '',
    ...FAQ.flatMap((f) => [`### ${f.q}`, '', f.a, ''])
  ].join('\n')
}
