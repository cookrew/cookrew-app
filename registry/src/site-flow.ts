import { esc, icon } from './site-shell'
import { currentLang } from './site-lang'
import { DEMO, figure } from './site-frames'

/**
 * THE FRONT PAGE, "LET YOUR TOKENS FLOW" (owner 2026-11-18: 按这版本做官网并发布). The copy, the order and the look follow
 * docs/cookrew-intro-2026-11-18/index.html; its Chinese is final and used verbatim (智能体助手, 跨设备 / 跨智能体助手 / 跨模型).
 * No status labels, roadmap or word of progress (owner 475f4a16). Every picture is the current UI on demo data, from
 * site-frames.ts DEMO at the pinned commit, and the page says so once, at its foot.
 *
 * A DOCUMENT: no script. The diagram is inline SVG; its moving dashes are CSS and stop for reduced motion.
 */

type Two = readonly [string, string]
type Point = readonly [string, string]

export interface FlowCopy {
  title: string
  kicker: string
  /** The headline: before, the highlighted words, after (and where it breaks on a wide screen). */
  h1: readonly [string, string, string]
  sub: string
  pills: readonly [string, string, string]
  lede: string
  download: string
  console: string
  source: string
  flows: { k: string; h2: string; lede: string; cards: readonly { title: string; text: string; go: string }[]; aria: string }
  diagram: {
    heads: readonly [string, string, string, string]
    devices: readonly [Two, Two, Two]
    hub: readonly [string, string, string, string, string]
    models: readonly [Two, Two, Two]
    tallDevices: readonly [string, string, string]
    tallHub: readonly [string, string, string]
  }
  chapters: readonly { id: string; k: string; h2: Two; lede: string; points: readonly [Point, Point, Point, Point] }[]
  lead: { k: string; h3: string; text: string; comment: string; ask: string }
  models: { comments: readonly [string, string, string]; credit: string; note: string }
  field: { k: string; h2: Two; lede: string; opsCaption: string }
  start: { k: string; h2: string; steps: readonly Two[]; loginComment: string; magpieComment: string }
  final: { k: string; h2: readonly [string, string, string] }
  pictures: string
}

export const FLOW_EN: FlowCopy = {
  title: 'Cookrew — let your tokens flow',
  kicker: 'OPEN SOURCE · MIT · CLAUDE CODE · CODEX · OPENCODE · PI',
  h1: ['Let your tokens ', 'flow freely', '.'],
  sub: 'One account. Across devices, across agents, across models.',
  pills: ['Across devices', 'Across agents', 'Across models'],
  lede: 'Cookrew is an open-source desktop workspace. Put Claude Code, Codex, OpenCode and Pi on one canvas, run them on every machine you own, and follow and answer them from the desktop, any browser or your phone.',
  download: 'Download for Mac',
  console: 'Open console',
  source: 'Source',
  flows: {
    k: 'Three flows',
    h2: 'Your work, no longer tied to one machine, one tool or one model provider',
    lede: 'Which machine runs it, which agent takes it, whose model answers: you decide, and you can change it any time.',
    cards: [
      { title: 'Across devices', text: 'Agents work on your machines; you follow and answer them from any device.', go: 'Away from the desk, still connected →' },
      { title: 'Across agents', text: 'Claude Code, Codex, OpenCode and Pi ask each other and hand work along on one canvas.', go: 'A crew, each at its best →' },
      { title: 'Across models', text: 'Subscriptions, API keys and local models in one gateway, shared out by your rules, the next taking over when one runs out.', go: 'No allowance wasted →' }
    ],
    aria: 'Your devices reach the agents on each machine; the agents take their models through the machine’s gateway, from your subscriptions, API keys and local models'
  },
  diagram: {
    heads: ['Across devices', 'Across agents', 'One gateway', 'Across models'],
    devices: [['Desktop app', 'Mac · Windows'], ['Any browser', 'console.cookrew.dev'], ['Phone', 'console · alerts']],
    hub: ['Magpie gateway', 'local · 127.0.0.1:3425', 'order · weight · fallback', 'metered per agent', 'keys stay here'],
    models: [['Subscriptions', 'Claude · ChatGPT …'], ['API keys', 'any provider'], ['Local models', 'Ollama …']],
    tallDevices: ['Desktop', 'Browser', 'Phone'],
    tallHub: ['Magpie gateway · local', 'order · weight · fallback', 'metered per agent · keys stay here']
  },
  chapters: [
    {
      id: 'devices',
      k: '01 · Across devices',
      h2: ['Leave the desk.', 'The work keeps flowing.'],
      lede: 'Every machine of your account sits on one canvas, Mac or server, and you see what each one is running. When an agent needs you, your phone tells you; open any browser and answer.',
      points: [
        ['One account, every machine', 'Each machine with its workspaces, agents and load, on one canvas.'],
        ['The console, anywhere', 'console.cookrew.dev opens in any browser and on any phone. Nothing to install.'],
        ['One bar for what needs you', 'Agents waiting on you, from every workspace and every machine, in one bar, with an alert on your phone.'],
        ['Take the screen when you need it', 'Turn on remote control on that machine and take its screen card, 15 minutes at a time.']
      ]
    },
    {
      id: 'harness',
      k: '02 · Across agents',
      h2: ['A crew of agents,', 'each at its best.'],
      lede: 'Claude Code drafts the plan, Codex reviews it, OpenCode runs the browser checks, Pi tidies the notes. On one canvas they ask each other, hand work along, and share notes and browsers.',
      points: [
        ['Four agents, one crew', 'Claude Code, Codex, OpenCode and Pi, plus a plain terminal, in one workspace.'],
        ['Agents ask each other', 'With one cookrew ask, any agent hands work to another and reads its reply.'],
        ['Every turn is a checkpoint', 'Scrub back through a session and fork a new agent from any step; the original keeps running.'],
        ['People and agents, one CLI', 'The commands you type, the lead agent types too: recruit, connect, ask, save the team.']
      ]
    },
    {
      id: 'models',
      k: '03 · Across models',
      h2: ['Pick any model.', 'Waste no allowance.'],
      lede: 'Your subscriptions, API keys and local models go into one gateway on your machine. All four agents take their models from it, in the order or weights you set, and when one runs out or goes down, the next one takes over.',
      points: [
        ['One gateway, four agents', 'Claude Code, Codex, OpenCode and Pi can all take the same route.'],
        ['Order, weights, fallback', 'Group several models: use one until it runs out, then the next, or split requests by weight.'],
        ['Keys stay out of Cookrew', 'Provider keys stay in the gateway; an agent gets only the local gateway’s address, a gateway key and a card tag.'],
        ['Usage per agent', 'Every request carries the card that made it, so usage is counted agent by agent.']
      ]
    }
  ],
  lead: {
    k: 'Like leading a team',
    h3: 'Let one agent lead, and it handles the rest',
    text: 'Make one agent the orch and tell it what you want: it recruits a reviewer, drops a note with the spec and opens a browser on the docs. You read the results and step in where you are needed.',
    comment: '# the lead agent runs the same commands you can',
    ask: 'Does this change break compatibility?'
  },
  models: {
    comments: ['# a review group: Claude first, DeepSeek when it cannot answer', '# pick it as the default in Cookrew’s Routing panel', '# every new card takes this route'],
    credit: 'Gateway by Magpie · yetone’s open-source project (MIT) · usemagpie.ai',
    note: 'Magpie is installed separately on the same machine. Until you pick a default model, each agent runs on its own login.'
  },
  field: {
    k: 'In the field',
    h2: ['Agents work in more than a terminal.', ''],
    lede: 'Browsers, computer screens and phone screens are cards on the canvas. An agent opens pages, clicks, fills in and reads; you watch alongside and take over when you are needed.',
    opsCaption: 'Controlling a computer’s or a phone’s screen needs the switch turned on at that machine, 15 minutes per grant.'
  },
  start: {
    k: 'Start',
    h2: 'Three steps to get your tokens flowing',
    steps: [
      ['Install Cookrew', 'Download the Mac app and add an agent: Claude Code, Codex, OpenCode or Pi, on its own login.'],
      ['Say what you want done', 'Write one sentence in the box at the foot of the window: it starts an agent and names it. Make it the orch and it recruits the rest of the crew.'],
      ['Keep going from anywhere', 'Sign in and open the console on your phone or in any browser to follow progress and answer questions; on a server, `cookrew login` adds it to your account.']
    ],
    loginComment: '# add a server to your account (the password goes only into a hidden prompt)',
    magpieComment: '# optional: install Magpie to let models flow'
  },
  final: { k: 'Open source · MIT · Free', h2: ['One account. ', 'Let your tokens flow', '.'] },
  pictures: 'Pictures show Cookrew’s current interface with demo data.',
}

export const FLOW_ZH: FlowCopy = {
  title: 'Cookrew · 让你的 token 自由流转',
  kicker: '开源 · MIT · Claude Code · Codex · OpenCode · Pi',
  h1: ['让你的 token\n', '自由流转', '。'],
  sub: '一个账号，跨设备、跨智能体助手、跨模型流转。',
  pills: ['跨设备', '跨智能体助手', '跨模型'],
  lede: 'Cookrew 是一个开源的桌面工作空间。把 Claude Code、Codex、OpenCode 和 Pi 放进同一张画布，在你的每台机器上运行；在桌面、任何浏览器或手机上跟进它们、回复它们。',
  download: '下载 Mac 版',
  console: '打开控制台',
  source: '源码',
  flows: {
    k: '三种流转',
    h2: '你的工作，不再被一台机器、一个工具、一家模型困住',
    lede: '任务在哪台机器上跑、交给哪个智能体助手、用哪家的模型，都由你决定，也随时可以换。',
    cards: [
      { title: '跨设备流转', text: '智能体助手在你的机器上干活，你在任何设备上跟进、回复。', go: '离开电脑也不断线 →' },
      { title: '跨智能体助手流转', text: 'Claude Code、Codex、OpenCode、Pi 在一张画布上互相提问、交接工作。', go: '一队智能体助手，各用所长 →' },
      { title: '跨模型流转', text: '订阅、API key、本地模型进同一个网关，按你的规则分配、自动接替。', go: '额度一分不浪费 →' }
    ],
    aria: '设备驱动每台机器上的智能体助手，智能体助手经本机的网关使用你的订阅、API key 和本地模型'
  },
  diagram: {
    heads: ['跨设备', '跨智能体助手', '一个网关', '跨模型'],
    devices: [['桌面 app', 'Mac · Windows'], ['任何浏览器', 'console.cookrew.dev'], ['手机', '控制台 · 提醒']],
    hub: ['Magpie 网关', '本机 · 127.0.0.1:3425', '顺序 · 权重 · 备用', '按智能体助手计量', 'key 只留在这里'],
    models: [['订阅', 'Claude · ChatGPT …'], ['API key', '任意服务商'], ['本地模型', 'Ollama …']],
    tallDevices: ['桌面 app', '任何浏览器', '手机'],
    tallHub: ['Magpie 网关 · 本机', '顺序 · 权重 · 备用', '按智能体助手计量 · key 只留在这里']
  },
  chapters: [
    {
      id: 'devices',
      k: '01 · 跨设备流转',
      h2: ['离开电脑，', '工作照常流转。'],
      lede: '你账号下的每台机器都在同一张画布上：Mac、服务器，一眼看清每台在跑什么。哪个智能体助手需要你，手机会提醒你；打开任何浏览器，接着看、直接回。',
      points: [
        ['一个账号，所有机器', '每台机器连同它的工作空间、智能体助手和负载，画在同一张画布上。'],
        ['控制台，随处可开', 'console.cookrew.dev 在任何浏览器、任何手机上打开，不用装应用。'],
        ['等你处理的事，一个栏', '所有工作空间、所有机器上等你的智能体助手汇成一栏，手机同时收到提醒。'],
        ['需要时，接管屏幕', '在那台机器上打开远程控制，就能接管它的屏幕卡片，每次 15 分钟。']
      ]
    },
    {
      id: 'harness',
      k: '02 · 跨智能体助手流转',
      h2: ['一队智能体助手，', '各用所长。'],
      lede: 'Claude Code 写方案，Codex 做审查，OpenCode 跑浏览器检查，Pi 整理笔记——它们在同一张画布上互相提问、交接工作，便签和浏览器全队共用。',
      points: [
        ['四种智能体助手，一个团队', 'Claude Code、Codex、OpenCode、Pi，还有普通终端，混编在一个工作空间里。'],
        ['智能体助手之间互相提问', '一条 cookrew ask，任何智能体助手都能把活交给另一个，再读回它的回复。'],
        ['每个回合都是检查点', '在会话里来回拖动，从任意一步分叉出新智能体助手，原会话照常运行。'],
        ['人和智能体助手，一套 CLI', '你能敲的命令，带队的智能体助手也能敲：招募、连接、提问、保存团队。']
      ]
    },
    {
      id: 'models',
      k: '03 · 跨模型流转',
      h2: ['模型随你挑，', '额度不浪费。'],
      lede: '你的订阅、API key 和本地模型，放进本机的同一个网关。四种智能体助手都从这里拿模型：按你定的顺序或权重分配，一个额度用完或服务宕机，下一个自动接上。',
      points: [
        ['一个网关，四种智能体助手', 'Claude Code、Codex、OpenCode、Pi 都可以走同一条路由。'],
        ['顺序、权重、备用', '几个模型组成一组，用完一个换下一个，或按权重分请求。'],
        ['key 不进 Cookrew', '服务商的 key 只留在网关里，智能体助手只拿到本地网关的地址、网关 key 和一张卡片标签。'],
        ['每个智能体助手，用量清楚', '每个请求都带着发出它的卡片，用量按智能体助手分开统计。']
      ]
    }
  ],
  lead: {
    k: '像指挥一支队伍',
    h3: '让一个智能体助手带队，其余交给它',
    text: '把一个智能体助手设为编排者，告诉它你要什么：它会招募审查者、放一张写规格的便签、开一个文档浏览器。你只看结果，在需要你的地方点一下。',
    comment: '# 带队的智能体助手运行的，就是你也能用的命令',
    ask: '这次改动有没有破坏兼容性？'
  },
  models: {
    comments: ['# 一个评审组：先用 Claude，答不了换 DeepSeek', '# 在 Cookrew 的 Routing 面板里选它做默认', '# 之后新开的每张卡片都走这条路由'],
    credit: '网关由 Magpie 提供 · yetone 的开源项目（MIT）· usemagpie.ai',
    note: 'Magpie 单独安装在同一台机器上。不选默认模型时，每个智能体助手照常用它自己的登录直接运行。'
  },
  field: {
    k: '工作现场',
    h2: ['智能体助手操作的，', '不只是终端。'],
    lede: '浏览器、电脑屏幕、手机屏幕都是画布上的卡片。智能体助手能打开网页、点击、填写、读取；你在旁边看着，需要你的时候接手。',
    opsCaption: '电脑和手机屏幕的控制，需要在那台机器上打开开关，每次授权 15 分钟。'
  },
  start: {
    k: '开始',
    h2: '三步，让 token 流转起来',
    steps: [
      ['装上 Cookrew', '下载 Mac 版，再装一个智能体助手：Claude Code、Codex、OpenCode 或 Pi，用它自己的登录。'],
      ['说出你要做的事', '在窗口底部的输入框写一句话，它就启动一个智能体助手并为它起名；设它为编排者，剩下的队伍它来招。'],
      ['随时随地接着管', '登录账号，在手机或任何浏览器里打开控制台，看进度、回问题；服务器上用 `cookrew login` 把它也加进账号。']
    ],
    loginComment: '# 服务器加入你的账号（密码只在隐藏提示里输入）',
    magpieComment: '# 可选：装上 Magpie，让模型流转起来'
  },
  final: { k: '开源 · MIT · 免费', h2: ['一个账号，', '让 token 流转起来', '。'] },
  pictures: '图片为 Cookrew 当前界面，使用演示数据。',
}

export const flow = (): FlowCopy => (currentLang() === 'zh' ? FLOW_ZH : FLOW_EN)

/** `code` in a sentence of copy becomes <code>; everything else is escaped. */
const inline = (text: string): string => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
const lines = (pair: Two): string => (pair[1] ? `${esc(pair[0])}<br>${esc(pair[1])}` : esc(pair[0]))

/** The flow drawn twice: wide (four columns, desktop) and tall (stacked, phones). Text in boxes, no picture. */
export function flowDiagram(): string {
  const d = flow().diagram
  const t = (cls: string, x: number, y: number, s: string): string => `<text class="${cls}" x="${x}" y="${y}">${esc(s)}</text>`
  const box = (x: number, y: number, w: number, h: number, cls = 'bx'): string => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${cls === 'hub' ? 12 : 9}"/>`
  const curve = (cls: string, x1: number, y1: number, x2: number, y2: number): string => {
    const mx = (x1 + x2) / 2
    return `<path class="${cls}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`
  }
  const agents = ['Claude Code', 'Codex', 'OpenCode', 'Pi']
  const agentY = [82, 146, 210, 274]
  const devY = [88, 174, 260]
  const modelY = [88, 174, 260]
  const hubY = 165
  let wide = t('h', 20, 22, d.heads[0]) + t('h', 300, 22, d.heads[1]) + t('h', 550, 22, d.heads[2]) + t('h', 800, 22, d.heads[3])
  d.devices.forEach(([title, sub], i) => {
    const y = devY[i]! - 28
    wide += box(20, y, 190, 56) + t('t', 34, y + 25, title) + t('s', 34, y + 42, sub)
    for (const ay of agentY) wide += curve('w', 210, devY[i]!, 300, ay)
  })
  agents.forEach((name, i) => {
    const y = agentY[i]! - 20
    wide += box(300, y, 170, 40) + t('t', 314, y + 25, name) + curve('flow', 470, agentY[i]!, 550, hubY)
  })
  wide += box(550, 95, 200, 140, 'hub') + t('t', 568, 128, d.hub[0]) + t('s', 568, 152, d.hub[1]) + t('s', 568, 176, d.hub[2]) + t('s', 568, 198, d.hub[3]) + t('s', 568, 220, d.hub[4])
  d.models.forEach(([title, sub], i) => {
    const y = modelY[i]! - 28
    wide += curve('flow', 750, hubY, 800, modelY[i]!) + box(800, y, 180, 56) + t('t', 814, y + 25, title) + t('s', 814, y + 42, sub)
  })
  const down = (y: number): string => `<path class="flow" d="M180 ${y} L180 ${y + 30}"/>`
  let tall = t('h', 20, 18, d.heads[0])
  d.tallDevices.forEach((name, i) => { tall += box(20 + i * 112, 28, 104, 52) + t('t', 34 + i * 112, 59, name) })
  tall += down(82) + t('h', 20, 128, d.heads[1])
  agents.forEach((name, i) => {
    const x = i % 2 === 0 ? 20 : 184
    const y = i < 2 ? 138 : 188
    tall += box(x, y, 156, 40) + t('t', x + 14, y + 25, name)
  })
  tall += down(232) + t('h', 20, 278, d.heads[2]) + box(20, 288, 320, 104, 'hub') + t('t', 34, 316, d.tallHub[0]) + t('s', 34, 340, d.tallHub[1]) + t('s', 34, 362, d.tallHub[2])
  tall += down(394) + t('h', 20, 440, d.heads[3])
  d.models.forEach(([title], i) => { tall += box(20, 450 + i * 36, 320, 30) + t('t', 34, 470 + i * 36, title) })
  return `<figure class="tf-diagram" role="img" aria-label="${esc(flow().flows.aria)}">
<svg class="tf-dg tf-dg-wide" viewBox="0 0 1000 330" aria-hidden="true">${wide}</svg>
<svg class="tf-dg tf-dg-tall" viewBox="0 0 360 560" aria-hidden="true">${tall}</svg>
</figure>`
}

const code = (rows: readonly (string | readonly ['$', string])[]): string =>
  `<pre class="tf-code">${rows.map((r) => (typeof r === 'string' ? `<span class="c">${esc(r)}</span>` : `<span class="a">$</span> ${esc(r[1])}`)).join('\n')}</pre>`

function chapterHead(k: string, h2: Two, lede: string): string {
  return `<div class="tf-ch-head"><div><p class="tf-k">${esc(k)}</p><h2>${lines(h2)}</h2></div><p class="tf-lede">${esc(lede)}</p></div>`
}

function points(list: readonly Point[]): string {
  return `<ul class="tf-points">${list.map(([b, s]) => `<li><b>${esc(b)}</b><span>${esc(s)}</span></li>`).join('')}</ul>`
}

const shot = (key: keyof typeof DEMO, sizes: string, cls = ''): string => figure(DEMO[key], { sizes, ...(cls ? { cls } : {}) })

export interface FlowLinks { mac: string; console: string; source: string; meta: string }

export function flowHero(links: FlowLinks): string {
  const f = flow()
  const [before, em, after] = f.h1
  return `<section class="tf-hero"><div class="wrap">
<p class="tf-k">${esc(f.kicker)}</p>
<h1>${esc(before).replace(/\n/g, '<br>')}<em>${esc(em)}</em>${esc(after)}</h1>
<p class="tf-sub">${esc(f.sub)}</p>
<div class="tf-pills">${f.pills.map((p, i) => `<span><b>0${i + 1}</b>${esc(p)}</span>`).join('')}</div>
<p class="tf-lede">${esc(f.lede)}</p>
${ctaRow(links, false)}
<p class="tf-meta">${links.meta}</p>
<div class="tf-hero-shot">${figure(DEMO.hero, { eager: true, sizes: '(max-width: 1180px) 100vw, 1120px' })}</div>
</div></section>`
}

function ctaRow(links: FlowLinks, source: boolean): string {
  const f = flow()
  return `<div class="tf-cta"${source ? '' : ' id="download"'}><a class="btn primary lg" href="${esc(links.mac)}">${icon('download')} ${esc(f.download)}</a><a class="btn lg" href="${esc(links.console)}/">${icon('mac')} ${esc(f.console)}</a>${source ? `<a class="btn lg" href="${esc(links.source)}">${esc(f.source)}</a>` : ''}</div>`
}

export function flowSections(links: FlowLinks): string {
  const f = flow()
  const [devices, harness, models] = f.chapters as readonly [FlowCopy['chapters'][number], FlowCopy['chapters'][number], FlowCopy['chapters'][number]]
  const hrefs = ['#devices', '#harness', '#models']
  const flows = `<section class="tf-band" id="flow"><div class="wrap">
<div class="tf-head"><p class="tf-k">${esc(f.flows.k)}</p><h2>${esc(f.flows.h2)}</h2><p>${esc(f.flows.lede)}</p></div>
<div class="tf-trio">${f.flows.cards.map((c, i) => `<a href="${hrefs[i]}"><div class="num">0${i + 1}</div><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><span class="go">${esc(c.go)}</span></a>`).join('')}</div>
${flowDiagram()}
</div></section>`
  const ch1 = `<section class="tf-ch" id="${devices.id}"><div class="wrap">
${chapterHead(devices.k, devices.h2, devices.lede)}
${points(devices.points)}
<div class="tf-shots tf-phones">${shot('devices', '(max-width: 900px) 100vw, 780px', 'tf-wide')}${shot('crewPhone', '(max-width: 900px) 50vw, 220px', 'tf-phone')}${shot('hitlPhone', '(max-width: 900px) 50vw, 220px', 'tf-phone')}</div>
</div></section>`
  const ch2 = `<section class="tf-ch" id="${harness.id}"><div class="wrap">
${chapterHead(harness.k, harness.h2, harness.lede)}
${points(harness.points)}
<div class="tf-shots tf-two">${shot('agents', '(max-width: 900px) 100vw, 700px')}${shot('hitlDesk', '(max-width: 900px) 100vw, 440px')}</div>
<div class="tf-split"><div><p class="tf-k">${esc(f.lead.k)}</p><h3>${esc(f.lead.h3)}</h3><p class="tf-note-lg">${esc(f.lead.text)}</p></div>
${code([f.lead.comment, ['$', 'cookrew recruit "Reviewer" --preset "Codex" --role "API review"'], ['$', 'cookrew connect "Planner" "Reviewer"'], ['$', `cookrew ask "Reviewer" "${f.lead.ask}"`], ['$', 'cookrew team save "Release Crew"']])}</div>
</div></section>`
  const ch3 = `<section class="tf-ch" id="${models.id}"><div class="wrap">
${chapterHead(models.k, models.h2, models.lede)}
${points(models.points)}
<div class="tf-split">${shot('routing', '(max-width: 900px) 100vw, 520px')}<div>
${code([f.models.comments[0], ['$', 'magpie group add review \\\n    models=claude/claude-sonnet-5-5,deepseek/deepseek-chat \\\n    routing=order'], f.models.comments[1], f.models.comments[2]])}
<span class="tf-credit">◆ ${esc(f.models.credit)}</span>
<p class="tf-note">${esc(f.models.note)}</p>
</div></div>
</div></section>`
  const field = `<section class="tf-ch" id="field"><div class="wrap">
${chapterHead(f.field.k, f.field.h2, f.field.lede)}
<div class="tf-shots tf-two"><div class="tf-capped">${shot('ops', '(max-width: 900px) 100vw, 700px')}<p class="tf-cap">${esc(f.field.opsCaption)}</p></div>
<div class="tf-stack">${shot('browserCard', '(max-width: 900px) 100vw, 440px')}${shot('workspaces', '(max-width: 900px) 100vw, 440px')}</div></div>
</div></section>`
  const start = `<section class="tf-start" id="start"><div class="wrap">
<div class="tf-head"><p class="tf-k">${esc(f.start.k)}</p><h2>${esc(f.start.h2)}</h2></div>
<ol class="tf-steps">${f.start.steps.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${inline(p)}</p></li>`).join('')}</ol>
<div class="tf-split tf-even">${code([f.start.loginComment, ['$', 'cookrew login'], ['$', 'cookrew whoami']])}${code([f.start.magpieComment, ['$', 'curl -fsSL https://usemagpie.ai/install.sh | sh'], ['$', 'magpie autostart on']])}</div>
</div></section>`
  const [b, em, a] = f.final.h2
  const final = `<section class="tf-final"><div class="wrap">
<p class="tf-k">${esc(f.final.k)}</p>
<h2>${esc(b)}<em>${esc(em)}</em>${esc(a)}</h2>
${ctaRow(links, true)}
<p class="tf-pictures">${esc(f.pictures)}</p>
</div></section>`
  return [flows, ch1, ch2, ch3, field, start, final].join('\n')
}

/** The page's own style, after the site's sheet: the site's colours, so day, night and the reader's pick follow. */
export const FLOW_STYLE = `
.tf-home p{max-width:none}
.tf-k{font:700 11px var(--font-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--amber-deep);margin:0}
.tf-hero p,.tf-head p,.tf-final p{margin-left:auto;margin-right:auto}
.tf-hero,.tf-band,.tf-ch,.tf-start,.tf-final{border:0}
.tf-hero::before,.tf-band::before,.tf-ch::before,.tf-start::before,.tf-final::before{display:none}
.tf-hero{padding:56px 0 30px;text-align:center}
.tf-hero .cr-ink-lockup{width:min(78vw,330px);height:auto;margin:0 auto 22px}
.tf-hero h1{font:600 clamp(40px,7vw,86px)/1.05 var(--font-serif);letter-spacing:-.02em;margin:18px 0 0;max-width:none}
.tf-hero h1 em,.tf-final h2 em{font-style:normal;background:linear-gradient(transparent 62%,var(--amber) 62%,var(--amber) 92%,transparent 92%);padding:0 .05em}
.tf-sub{font:500 clamp(17px,2.2vw,23px)/1.5 var(--font-serif);color:var(--ink-soft);margin:22px auto 0;max-width:30em}
.tf-pills{display:inline-flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:26px 0 0}
.tf-pills span{font:600 13px var(--font-body);padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:var(--cream-hi)}
.tf-pills b{color:var(--amber-deep);font-family:var(--font-mono);margin-right:6px}
.tf-hero .tf-lede{max-width:40em;margin:26px auto 0;color:var(--muted);font-size:16.5px;line-height:1.7}
.tf-cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:30px 0 0}
.tf-meta{font:12px var(--font-mono);color:var(--muted);margin:14px 0 0;letter-spacing:.02em}
.tf-hero-shot{margin:48px auto 0;max-width:1120px}
.tf-hero-shot figure.shot{border-radius:18px}
.tf-band{padding:90px 0 40px}
.tf-head{text-align:center;max-width:44em;margin:0 auto}
.tf-head h2,.tf-start h2{font:600 clamp(28px,4vw,46px)/1.15 var(--font-serif);margin:10px 0 0}
.tf-head p:not(.tf-k){color:var(--ink-soft);margin:14px 0 0;font-size:17px}
.tf-trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:44px 0 0}
.tf-trio a{display:block;text-decoration:none;background:var(--cream-hi);border:1px solid var(--hair);border-radius:16px;padding:24px 24px 22px;box-shadow:var(--lift-sm);transition:transform .2s,box-shadow .2s}
.tf-trio a:hover{transform:translateY(-3px);box-shadow:var(--lift)}
.tf-trio .num{font:700 40px/1 var(--font-serif);color:var(--amber-deep)}
.tf-trio h3{font:600 22px var(--font-serif);margin:14px 0 8px}
.tf-trio p{margin:0;color:var(--muted);font-size:15px}
.tf-trio .go{font:700 11px var(--font-mono);letter-spacing:.1em;color:var(--ink-soft);margin-top:16px;display:block}
.tf-diagram{margin:40px 0 0;background:var(--cream-hi);border:1px solid var(--hair);border-radius:18px;padding:26px 18px;box-shadow:var(--lift-sm)}
.tf-diagram svg{display:block;width:100%;height:auto}
.tf-dg text{font-family:'JetBrains Mono','PingFang SC',monospace;fill:var(--ink)}
.tf-dg .h{font-size:11px;letter-spacing:.14em;fill:var(--amber-deep);font-weight:700;text-transform:uppercase}
.tf-dg .t{font-size:14px;font-weight:700}.tf-dg .s{font-size:11.5px;fill:var(--muted)}
.tf-dg .bx{fill:var(--cream);stroke:var(--line)}
.tf-dg .hub{fill:var(--amber-soft);stroke:var(--amber-deep);stroke-width:1.6}
.tf-dg .w{fill:none;stroke:var(--ink-soft);stroke-width:1.3;opacity:.55}
.tf-dg .flow{fill:none;stroke:var(--amber-deep);stroke-width:2.2;stroke-dasharray:6 10;animation:tf-dash 1.6s linear infinite}
@keyframes tf-dash{to{stroke-dashoffset:-32}}
@media (prefers-reduced-motion:reduce){.tf-dg .flow{animation:none}}
.tf-diagram .tf-dg-tall{display:none}
.tf-ch{padding:110px 0 30px;scroll-margin-top:70px}
.tf-ch-head{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:56px;align-items:end}
.tf-ch-head h2{font:600 clamp(32px,4.6vw,56px)/1.08 var(--font-serif);margin:12px 0 0;max-width:none}
.tf-ch-head .tf-lede{font:500 19px/1.65 var(--font-serif);color:var(--ink-soft);margin:0}
.tf-points{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:40px 0 0;padding:0;list-style:none}
.tf-points li{border-top:2px solid var(--ink);padding:14px 2px 0}
.tf-points b{display:block;font:600 17px var(--font-serif);margin-bottom:6px}
.tf-points span{color:var(--muted);font-size:14.5px;line-height:1.6}
.tf-shots{display:grid;gap:20px;margin:44px 0 0;align-items:start}
.tf-shots.tf-two{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
.tf-shots.tf-phones{grid-template-columns:minmax(0,2.2fr) minmax(0,.6fr) minmax(0,.6fr)}
.tf-stack{display:grid;gap:20px}
.tf-ch figure.shot,.tf-start figure.shot{border-radius:16px;margin:0}
.tf-ch figure.shot.tf-phone{border-radius:28px;border:8px solid #2a261f;background:#2a261f}
.tf-capped{display:grid;gap:0}
.tf-capped figure.shot{border-bottom-left-radius:0;border-bottom-right-radius:0}
.tf-cap{font:12.5px/1.5 var(--font-body);color:var(--muted);padding:10px 14px;margin:0;border:1px solid var(--hair);border-top:0;background:var(--cream-hi);border-radius:0 0 16px 16px}
.tf-code{font:13.5px/1.75 var(--font-mono);background:var(--phos-bg);color:var(--phos);border-radius:14px;padding:18px 22px;overflow-x:auto;white-space:pre;box-shadow:var(--lift-sm);margin:0}
.tf-code .c{color:#9a917f;white-space:pre-wrap}.tf-code .a{color:#e2b866}
.tf-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:28px;margin:44px 0 0;align-items:start}
.tf-split.tf-even{grid-template-columns:1fr 1fr}
.tf-split h3{font:600 26px/1.25 var(--font-serif);margin:10px 0 0}
.tf-note-lg{font-size:15.5px;color:var(--muted);margin:14px 0 0}
.tf-note{font-size:13.5px;color:var(--muted);margin:14px 0 0}
.tf-credit{display:inline-flex;gap:8px;align-items:center;font:600 12px var(--font-mono);border:1px dashed var(--line);border-radius:999px;padding:5px 12px;margin-top:18px;color:var(--ink-soft)}
.tf-start{padding:120px 0 60px;scroll-margin-top:70px}
.tf-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:40px 0 0;counter-reset:s;padding:0;list-style:none}
.tf-steps li{counter-increment:s;background:var(--cream-hi);border:1px solid var(--hair);border-radius:16px;padding:22px 22px 20px;box-shadow:var(--lift-sm)}
.tf-steps li::before{content:counter(s);display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--amber);color:#1d1a16;font:700 14px var(--font-mono);margin-bottom:14px}
.tf-steps h3{font:600 20px var(--font-serif);margin:0 0 6px}.tf-steps p{margin:0;color:var(--muted);font-size:15px}
.tf-final{text-align:center;padding:90px 0 40px}
.tf-final h2{font:600 clamp(30px,5vw,58px)/1.15 var(--font-serif);margin:14px 0 0}
.tf-pictures{margin:48px 0 0;font-size:13px;color:var(--muted)}
@media (max-width:900px){
.tf-ch-head,.tf-split,.tf-split.tf-even,.tf-shots.tf-two{grid-template-columns:minmax(0,1fr);gap:22px}
.tf-points{grid-template-columns:repeat(2,minmax(0,1fr))}.tf-trio,.tf-steps{grid-template-columns:minmax(0,1fr)}
.tf-shots.tf-phones{grid-template-columns:repeat(2,minmax(0,1fr))}.tf-shots.tf-phones .tf-wide{grid-column:1/-1}
.tf-diagram .tf-dg-wide{display:none}.tf-diagram .tf-dg-tall{display:block;max-width:420px;margin:0 auto}
.tf-hero{padding-top:36px}.tf-ch{padding-top:80px}
}
@media (max-width:640px){.tf-ch figure.shot:not(.narrow),.tf-hero figure.shot:not(.narrow){margin-inline:0;border-left:1px solid var(--hair);border-right:1px solid var(--hair)}.tf-ch figure.shot.tf-phone:not(.narrow){border:6px solid #2a261f;border-radius:22px}}
@media (max-width:520px){.tf-points{grid-template-columns:minmax(0,1fr)}.tf-code{font-size:12px;padding:14px 16px}}
`
