import { LEGAL_PUBLISHED } from './site-legal-entity'
import type { DemoKey } from './site-frames'
import { currentLang } from './site-lang'
import { FLOW_EN } from './site-flow'
import { ZH_COMPARE, ZH_DEFINITION, ZH_FAQ, ZH_FEATURES, ZH_START_FAQ, ZH_START_HOWTO } from './site-content-zh'

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
 * Nothing here is a claim about the future. Every pillar claim has a STATUS
 * in this file; the page and llms.txt carry only the shipped ones, with no
 * label and no word of progress (owner 2026-11-18).
 */

export const SITE_NAME = 'Cookrew'
export const SITE_ORIGIN = 'https://cookrew.dev'
export const GITHUB_REPO = 'https://github.com/cookrew/cookrew-app'

/** The one-sentence entity definition. Meta description, JSON-LD, llms.txt, the hero. */
export const DEFINITION =
  'Cookrew is an open-source desktop workspace. Put Claude Code, Codex, OpenCode and Pi on one canvas, run them on every machine you own, and follow and answer them from the desktop, any browser or your phone.'

export const HEADLINE = 'Let your tokens flow freely.'

/** The line under the headline (owner 2026-11-18: "One account", not "one sign-in"). */
export const HEADLINE_SUB = 'One account. Across devices, across agents, across models.'

export const MARKET_DEFINITION =
  'The Cookrew marketplace lists served teams: teams of AI agents that stay on their author’s machine. A caller signs in with a cookrew.dev account, buys a seat once if the team is priced, and gets a sandboxed session of their own. The relay carries encrypted bytes it cannot read; money goes directly from caller to author and cookrew.dev takes no cut.'

export const CHECKPOINT_DEFINITION =
  'In Cookrew every agent turn is a checkpoint. You can scrub back through a session and fork a new agent from any past turn. Forking or exporting copies from a checkpoint and never touches the original session.'

/** Dated facts. The date is part of the fact; an undated number is a rumour. */
export const FACTS = {
  testsGreen: { value: '4,975', date: '2026-09-03', note: 'vitest, full suite on the dev branch' },
  license: 'MIT',
  harnesses: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell'],
  platforms: ['macOS (Apple Silicon)', 'Windows'],
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
    a: `Yes. Cookrew is ${FACTS.license}-licensed and developed in the open at ${GITHUB_REPO}. The desktop app is free.`
  },
  {
    q: 'Which AI coding agents does Cookrew run?',
    a: 'Claude Code, Codex, OpenCode and Pi ship as presets, plus a plain shell. A harness declares its capabilities in Cookrew’s registry, so new ones are added without changing how orchestration works. Any mix of them can work in one team.'
  },
  {
    q: 'Can I run Claude Code and Codex together?',
    a: 'Yes. Start both — from the prompt box at the foot of the window, or with cookrew recruit --preset — wire them with cookrew connect, and make one of them the orchestrator. Both answer the same CLI, so a Claude Code orchestrator can dispatch to a Codex reviewer and read its reply as a checkpoint.'
  },
  {
    q: 'Do I need my own API keys?',
    a: 'You bring the models; Cookrew offers none of its own. By default a card runs its harness directly, on that harness’s own login or key, exactly as in a terminal. Install Magpie (usemagpie.ai) on the same machine and pick a default model in the Routing panel, and new Claude Code, Codex, OpenCode and Pi cards are routed through it instead, using the subscriptions, API keys or local models you set up there. Either way the provider keys stay out of Cookrew.'
  },
  {
    q: 'Is my code sent to cookrew.dev?',
    a: `cookrew.dev does not store your code. Saving a team writes a file on your machine. Your canvas leaves it only if you publish a team or a preset to cookrew.dev, or open it from the console through the relay. The console takes the local network or Tailscale when it can; through the relay the traffic is encrypted in transit, not end-to-end sealed${LEGAL_PUBLISHED ? ` (see ${SITE_ORIGIN}/privacy)` : ''}.`
  },
  {
    q: 'Can I reach my agents from a browser or from my phone?',
    a: 'Yes. Sign in to the console and every machine of your account is there with its workspaces, agents and transcripts, in any browser and on a phone. It takes the local network or Tailscale when it can and the relay when it cannot; through the relay the traffic is encrypted in transit, not end-to-end sealed.'
  },
  { q: 'What is a checkpoint?', a: CHECKPOINT_DEFINITION },
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
  { question: 'Can you see the whole team’s state?', chat: 'No', singleAgent: 'One terminal at a time', cookrew: 'Every agent’s state under its name, across machines' },
  { question: 'Can you save and reuse a team?', chat: 'No', singleAgent: 'Config files', cookrew: 'Save a team; create a workspace from it in one command' },
  { question: 'Can each agent use the models you choose?', chat: 'The vendor’s', singleAgent: 'One provider per CLI', cookrew: 'Every harness routed through your own gateway' },
  { question: 'Works from a phone?', chat: 'Yes', singleAgent: 'No', cookrew: 'The console in any browser: machines, agents, transcripts' }
]

export interface FeatureSpec {
  slug: string
  /** Intent-shaped title — what somebody types into a search box. */
  title: string
  short: string
  definition: string
  pts: string[]
  /** Pictures from site-frames.ts DEMO: the current UI on demo data. Empty: no picture shows this yet, and none stands in. */
  frames: DemoKey[]
  /** The twenty-second clip on demo data (site-motion.ts CANVAS_CLIP), above the stills. */
  clip?: true
  faq: Faq[]
  related: string[]
}

export const FEATURES: FeatureSpec[] = [
  {
    slug: 'canvas',
    title: 'A spatial canvas for AI agents: terminals, notes and browsers',
    short: 'Every agent is a real terminal running a real agent. Click in from your machines to a crew, to one agent’s card, to its whole transcript — and click out again.',
    definition:
      'The Cookrew canvas is a zoom you walk by clicking: your machines, a machine’s workspaces, one workspace’s crew tied by ink cables, one agent’s card, and its whole transcript. Each agent is a live terminal with a name, a role and a turn tracker; sticky notes hold specs and handovers; browser cards are real Chromium tabs an agent can drive; and the cables say who hands work to whom.',
    pts: ['Agent terminals with a name, a role and a live turn tracker', 'Sticky notes for specs, reviews and handovers', 'Connected browser cards that agents can drive', 'Wires say who hands work to whom, and who reviews whom'],
    frames: ['hitlDesk', 'artifacts'],
    clip: true,
    faq: [
      { q: 'Is the terminal on a card a real terminal?', a: 'Yes. Each card is a PTY hosted by tmux or herdr, running the harness’s own CLI. What you see is what the agent sees.' },
      { q: 'Can an agent use a browser card?', a: 'Yes. Browser cards are Chromium pages driven over the DevTools protocol; an agent can navigate, click, fill and read them with the cookrew browser commands.' }
    ],
    related: ['harnesses', 'checkpoints', 'board']
  },
  {
    slug: 'harnesses',
    title: 'Run Claude Code, Codex, OpenCode and Pi in one team',
    short: 'Claude Code, Codex, OpenCode, Pi and a plain shell ship as presets. Each runs on its own login, or through your own Magpie gateway.',
    definition:
      'A harness is an agent CLI Cookrew knows how to host, watch and dispatch to. Claude Code, Codex, OpenCode and Pi ship as presets; each declares its capabilities in Cookrew’s registry, so orchestration is the same command line whatever answers.',
    pts: ['Pick a preset, click the canvas, the teammate boots and its card opens', 'One CLI for every harness; the orchestrator does not care which one answers', 'The turn tracker reports thinking, waiting and replied from the harness itself, no scraping', 'Route each harness through your own Magpie gateway, or run it directly on its own login'],
    frames: ['board'],
    faq: [
      { q: 'Can I add a harness Cookrew does not ship?', a: 'A harness is a registry entry that declares how it starts, how its turns are detected and what it can do. New ones are added there without touching call sites.' }
    ],
    related: ['canvas', 'cli', 'marketplace']
  },
  {
    slug: 'checkpoints',
    title: 'Every agent turn is a checkpoint: scrub, fork, rewind',
    short: 'Scrub back through a session and fork a new agent from any past turn; nothing ever touches the original.',
    definition: CHECKPOINT_DEFINITION,
    pts: ['The rail beside the live terminal lists every turn as it lands', 'Hold the rail and drag: the transcript follows you back; drag far and the checkpoints open as a list of titled turns', 'Fork from turn N; the original keeps running', 'History trace: each checkpoint carries the block the agent actually produced'],
    frames: [],
    faq: [
      { q: 'What happens to my session when I fork or export?', a: 'Nothing. Forking and exporting both copy from a checkpoint; the original session is never touched.' },
      { q: 'Where do checkpoints come from?', a: 'From the harness’s own session record: Cookrew reads the transcript the agent writes, so a checkpoint is the turn as the agent saw it, not a scrape of the screen.' }
    ],
    related: ['canvas', 'board', 'marketplace']
  },
  {
    slug: 'board',
    title: 'Every agent’s state at a glance, across machines and workspaces',
    short: 'Step out to your machines and every workspace shows how many agents it holds; step into one and each agent wears its state under its name.',
    definition:
      'Cookrew’s fleet view is the top of the zoom: every machine with its workspaces and how many agents each one holds, and inside a workspace every agent with its state — working, done, resting, offline or waiting on you — under its name. Red is kept for the agent that is waiting on you.',
    pts: ['Machines, then workspaces, then a crew: one click each', 'Each agent shows working, done, resting, offline or waiting', 'Red is kept for the agent waiting on you', 'The command box gathers what is waiting on you in one list'],
    frames: ['devices'],
    faq: [{ q: 'Does the fleet view show offline agents?', a: 'Yes. An agent with no live pane shows as offline under its name; its history is still there.' }],
    related: ['checkpoints', 'workspaces']
  },
  {
    slug: 'cli',
    title: 'Orchestrate coding agents from one command line',
    short: 'People and agents share one CLI. Whatever you can type, the orchestrating agent can type too.',
    definition:
      'The cookrew CLI is the one interface for people and agents alike: recruit a teammate, connect two cards, ask an agent and wait for its reply, read its status, fork it from a turn, save a team, create a workspace from a template. An orchestrating agent runs the same commands you do.',
    pts: ['recruit, connect, ask, status, fork, team save, workspace create', 'ask waits for the reply and returns it; status is thinking, waiting, replied or idle', 'Saved teams snapshot nodes, wires and turn histories in one file', 'Every agent on every harness answers the same commands'],
    frames: [],
    faq: [{ q: 'Can an agent orchestrate other agents?', a: 'Yes. Make an agent the workspace’s orch; it can recruit, connect, ask and read status exactly as a person can, which is what makes a commander leading a crew a native way to work.' }],
    related: ['harnesses', 'workspaces']
  },
  {
    slug: 'mobile',
    title: 'Your agents on a phone: the console, or the companion on your Wi-Fi',
    short: 'Open the console in a phone’s browser and every machine of your account is there: crews, cards, transcripts and a box to reply. On the same Wi-Fi, the companion opens from a QR code.',
    definition:
      'A phone reaches your agents two ways. Signed in, the console opens in any phone browser, on any network, with every machine of your account. On the same Wi-Fi or Tailscale, the companion your desktop app hosts opens from a QR code: the same zoom by touch — crew, card, whole transcript with its rail — voice input and spoken replies, and a fixed slug URL per workspace for a bookmark.',
    pts: ['The console: any phone browser, any network, every machine of your account', 'The companion: cookrew mobile prints a QR code on your Wi-Fi or Tailscale', 'The same zoom by touch: crew, card, transcript', 'Voice in, spoken replies out'],
    frames: ['hitlPhone', 'phoneWorkspaces'],
    faq: [{ q: 'Does the phone need an app installed?', a: 'No. The console and the companion are both web pages; a phone opens either in its browser.' }],
    related: ['canvas', 'board']
  },
  {
    slug: 'workspaces',
    title: 'Workspaces and saved teams: one project, one crew',
    short: 'Switching a workspace switches the whole team and the whole canvas. Create one from a saved template and a full crew is on duty at once.',
    definition:
      'A Cookrew workspace is a project directory with its own canvas, team and history. A saved team is a template of nodes, wires and turn histories; cookrew workspace create --team puts a saved formation to work in a new directory immediately.',
    pts: ['A workspace is a project directory with its own canvas, crew and history', 'workspace create --team puts a saved formation to work immediately', 'Every workspace of every machine is listed in the console'],
    frames: ['browserCard', 'docsCrew'],
    faq: [{ q: 'What is in a saved team?', a: 'Its cards, the wires between them and their turn histories, in one file. Saving a team never touches the original session.' }],
    related: ['cli', 'marketplace']
  },
  {
    slug: 'marketplace',
    title: 'The agent team marketplace: open someone’s crew from the app',
    short: 'The marketplace lists doors, not copies. A team stays on its author’s machine; you sign in, buy a seat once if it is priced, and get a live sandboxed session of your own.',
    definition: MARKET_DEFINITION,
    pts: ['One cookrew.dev link: served on the author’s side, opened on yours', 'The relay carries bytes it cannot read; the author can end a session any time', '200 signed delivery · 401 sign in · 402 pay · 403 not covered — money goes straight to the author', 'The placed card is the team’s own terminal, the same PTY its author sees'],
    frames: [],
    faq: [
      { q: 'Can the team’s author see what I type?', a: 'Yes. The session runs on their machine, so the author can see what you send and what their agents do with it, and can end the session. The relay in between cannot read it.' },
      { q: 'What can a served team access on my computer?', a: 'No files and no programs: it runs on the author’s machine in a sandbox, and the app only carries keystrokes and screen bytes. Like any terminal, text you select in its card is copied to your clipboard, so a served team can place text there; it cannot read your clipboard.' }
    ],
    related: ['harnesses', 'checkpoints', 'workspaces']
  }
]

/**
 * THE FEATURES THE SITE POINTS AT (2026-11-16). The marketplace page is still
 * built, so an old link lands somewhere true, but nothing lists it — not the
 * front page, the sitemap, llms.txt or another feature's related links —
 * while sharing a team waits on security work and the owner's ruling.
 */
export const LISTED_FEATURES: readonly FeatureSpec[] = FEATURES.filter((f) => f.slug !== 'marketplace')

/** The two steps on /start. Orchestration is the orch's work; a person places one agent and asks. */
export const START_HOWTO: { name: string; text: string; detail: string[] }[] = [
  {
    name: 'Place an agent, and let it orchestrate your workflow',
    text: 'Install Cookrew and type what you want done into the prompt box at the foot of the window: with nobody targeted it starts a new agent — Claude Code, Codex, OpenCode or Pi — and names it from what you wrote. Make that agent the orch. It recruits teammates, drops notes and opens browsers with the same CLI you have; you read the replies on the rail.',
    detail: [
      'cookrew orch "Forge" — one agent is the door; the rest is its crew',
      'Ask it: "recruit a reviewer on Codex, a note with the spec, a browser on the docs" — it runs cookrew recruit, connect, note create, browser create',
      'Every turn lands on the card’s rail as a checkpoint; cookrew status says thinking, waiting or replied'
    ]
  },
  {
    name: 'Save the team, and start the next project with it',
    text: 'Select the cards and save the team: nodes, wires and turn histories in one file, the original session untouched. Create your next workspace from it and the whole crew is on duty at once.',
    detail: [
      'cookrew team save "MY CREW"',
      'cookrew workspace create "Next project" --team "MY CREW"',
      'Follow the new crew from the console, on any machine of your account'
    ]
  }
]

export const START_FAQ: Faq[] = [
  { q: 'What do I need before installing Cookrew?', a: 'A Mac with Apple Silicon or a Windows PC, Node 20+ if you build from source, tmux or herdr to host terminals, and the agent CLIs you want to run (Claude Code, Codex, OpenCode, Pi) with their own logins.' },
  { q: 'Do I need an account to use Cookrew?', a: 'No. The app runs entirely on your machine. A cookrew.dev account is needed only to reach your machines from the console.' }
]

/** Everything a crawler or a model needs, as plain text: /llms.txt. */
export function llmsText(): string {
  return llmsBody()
}

function llmsBody(): string {
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${DEFINITION}`,
    '',
    `- Website: ${SITE_ORIGIN}`,
    `- Source: ${GITHUB_REPO} (${FACTS.license})`,
    `- Getting started: ${SITE_ORIGIN}/start`,
    `- Features: ${LISTED_FEATURES.map((f) => `${SITE_ORIGIN}/features/${f.slug}`).join(', ')}`,
    '',
    '## Definitions',
    '',
    `- Checkpoint: ${CHECKPOINT_DEFINITION}`,
    '',
    '## What Cookrew does',
    '',
    `${FLOW_EN.sub}`,
    '',
    ...FLOW_EN.chapters.flatMap((c) => [`### ${c.k.replace(/^\d+ · /, '')}: ${c.h2.join(' ')}`, '', c.lede, '', ...c.points.map(([b, t]) => `- ${b}: ${t}`), '']),
    `Gateway: ${FLOW_EN.models.credit}. ${FLOW_EN.models.note}`,
    '',
    '## Facts',
    '',
    `- Harnesses: ${FACTS.harnesses.join(', ')}`,
    `- Platforms: ${FACTS.platforms.join(', ')}`,
    `- Relay: an owner reaching their own machine through the relay is encrypted in transit, not end-to-end sealed${LEGAL_PUBLISHED ? ` (${SITE_ORIGIN}/privacy)` : ''}`,
    '',
    '## FAQ',
    '',
    ...FAQ.flatMap((f) => [`### ${f.q}`, '', f.a, ''])
  ].join('\n')
}

/**
 * THE WORDS IN THE LANGUAGE BEING DRAWN (owner 2026-11-18: English and Chinese). The constants above are the English
 * text and stay as they are (llms.txt and the tests read them); the page builders ask these instead. Chinese text is
 * site-content-zh.ts, the same facts.
 */
const zh = (): boolean => currentLang() === 'zh'
export const definition = (): string => (zh() ? ZH_DEFINITION : DEFINITION)
export const faq = (): readonly Faq[] => (zh() ? ZH_FAQ : FAQ)
export const compare = (): readonly CompareRow[] => (zh() ? ZH_COMPARE : COMPARE)
export const startHowto = (): readonly { name: string; text: string; detail: readonly string[] }[] => (zh() ? ZH_START_HOWTO : START_HOWTO)
export const startFaq = (): readonly Faq[] => (zh() ? ZH_START_FAQ : START_FAQ)
const featureIn = (f: FeatureSpec): FeatureSpec => (zh() && ZH_FEATURES[f.slug] ? { ...f, ...ZH_FEATURES[f.slug] } : f)
export const features = (): readonly FeatureSpec[] => FEATURES.map(featureIn)
export const listedFeatures = (): readonly FeatureSpec[] => LISTED_FEATURES.map(featureIn)
