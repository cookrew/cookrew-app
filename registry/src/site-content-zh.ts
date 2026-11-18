import { LEGAL_PUBLISHED } from './site-legal-entity'

/**
 * 中文版的文字（owner 2026-11-18）。与 site-content.ts 一一对应：同样的事实、同样的状态标签，只换语言。
 * 英文是原文；这里改动一处事实，那边也要改。
 */

export const ZH_DEFINITION =
  'Cookrew 是一个开源的桌面工作空间。把 Claude Code、Codex、OpenCode 和 Pi 放进同一张画布，在你的每台机器上运行；在桌面、任何浏览器或手机上跟进它们、回复它们。'

export const ZH_CHECKPOINT_DEFINITION =
  '在 Cookrew 里，每个 agent 回合都是一个检查点。你可以在会话里来回拖动，从任意一个过去的回合分叉出新的 agent。分叉或导出都从检查点复制，从不改动原会话。'

export const ZH_MARKET_DEFINITION =
  'Cookrew 市场列出的是“提供服务的团队”：AI agent 团队始终留在作者自己的机器上。调用者用 cookrew.dev 账号登录，若团队收费则一次性购买席位，然后得到一个属于自己的沙箱会话。中继只转发它读不懂的加密字节；钱直接从调用者付给作者，cookrew.dev 不抽成。'

export const ZH_FAQ = [
  { q: 'Cookrew 是什么？', a: ZH_DEFINITION },
  { q: 'Cookrew 免费、开源吗？', a: '是的。Cookrew 采用 MIT 许可，在 https://github.com/cookrew/cookrew-app 公开开发。桌面应用免费。' },
  {
    q: 'Cookrew 能运行哪些 AI 编程 agent？',
    a: 'Claude Code、Codex、OpenCode 和 Pi 作为预设随应用提供，另有一个普通 shell。每个 harness 在 Cookrew 的注册表里声明自己的能力，因此新增 harness 不需要改变编排方式。它们可以任意组合在一个团队里。'
  },
  {
    q: '能让 Claude Code 和 Codex 一起工作吗？',
    a: '可以。在窗口底部的输入框里，或用 cookrew recruit --preset 把两个都启动起来，用 cookrew connect 连接，再让其中一个做编排者（orch）。两者都响应同一套 CLI，所以 Claude Code 编排者可以把任务派给 Codex 审查者，并把它的回复当作检查点读取。'
  },
  {
    q: '我需要自己的 API key 吗？',
    a: '模型由你自己带来；Cookrew 本身不提供模型。默认情况下，每张卡片直接运行它的 harness，用这个 harness 自己的登录或 key，和在终端里一模一样。在同一台机器上安装 Magpie（usemagpie.ai），并在 Routing 面板里选一个默认模型后，新的 Claude Code、Codex、OpenCode 和 Pi 卡片就会改走 Magpie，使用你在那里配置的订阅、API key 或本地模型。无论哪种方式，服务商的 key 都不会进入 Cookrew。'
  },
  {
    q: '我的代码会被发送到 cookrew.dev 吗？',
    a: `cookrew.dev 不存储你的代码。保存团队只会在你的机器上写一个文件。只有当你把团队或预设发布到 cookrew.dev，或通过中继从控制台打开时，你的画布才会离开本机。控制台能用局域网或 Tailscale 时就用它们；经过中继时，流量在传输中加密，不是端到端加密${LEGAL_PUBLISHED ? '（见 https://cookrew.dev/privacy）' : ''}。`
  },
  {
    q: '能在浏览器或手机上访问我的 agent 吗？',
    a: '可以。登录控制台，你账号下的每台机器都在那里，连同它们的工作空间、agent 和对话记录，任何浏览器、手机都可以。能用局域网或 Tailscale 时就用它们，不能时走中继；经过中继时流量在传输中加密，不是端到端加密。'
  },
  { q: '什么是检查点？', a: ZH_CHECKPOINT_DEFINITION }
]

export const ZH_COMPARE = [
  { question: '同时有几个 agent 在工作？', chat: '一个助手', singleAgent: '每个终端一个 CLI agent', cookrew: '一个团队在同一张画布上，彼此连接' },
  { question: 'agent 之间能交接工作吗？', chat: '不能', singleAgent: '一个 harness 内部的子 agent', cookrew: '任何 harness 都能通过同一套 CLI 派活给其他 harness' },
  { question: '能回到之前的回合吗？', chat: '往上翻', singleAgent: '部分 harness 能回退', cookrew: '每个回合都是检查点；可从任意一个分叉出 agent' },
  { question: '能看到整个团队的状态吗？', chat: '不能', singleAgent: '一次一个终端', cookrew: '每个 agent 的状态写在它名字下面，跨机器' },
  { question: '能保存并复用一个团队吗？', chat: '不能', singleAgent: '配置文件', cookrew: '保存团队；一条命令就能用它创建工作空间' },
  { question: '每个 agent 都能用你选的模型吗？', chat: '只能用厂商的', singleAgent: '每个 CLI 一个服务商', cookrew: '每个 harness 都可经你自己的网关路由' },
  { question: '手机上能用吗？', chat: '能', singleAgent: '不能', cookrew: '控制台在任何浏览器里：机器、agent、对话记录' }
]

/** Feature pages: the words only; frames, clip and related links are the English entry's. */
export const ZH_FEATURES: Readonly<Record<string, { title: string; short: string; definition: string; pts: string[]; faq: { q: string; a: string }[] }>> = {
  canvas: {
    title: 'AI agent 的空间画布：终端、便签和浏览器',
    short: '每个 agent 都是一个真实终端里运行的真实 agent。从你的机器点进一个团队，再点进一个 agent 的卡片，直到它完整的对话记录，然后再点回来。',
    definition:
      'Cookrew 画布是一个靠点击行走的缩放视图：你的机器、一台机器的工作空间、一个工作空间里由墨线连起来的团队、一个 agent 的卡片，以及它完整的对话记录。每个 agent 都是一个带名字、角色和回合追踪的实时终端；便签存放规格和交接；浏览器卡片是 agent 可以操控的真实 Chromium 标签页；连线说明谁把工作交给谁。',
    pts: ['带名字、角色和实时回合追踪的 agent 终端', '用于规格、评审和交接的便签', 'agent 可以操控的已连接浏览器卡片', '连线说明谁把工作交给谁、谁评审谁'],
    faq: [
      { q: '卡片上的终端是真实终端吗？', a: '是的。每张卡片都是由 tmux 或 herdr 托管的 PTY，运行 harness 自己的 CLI。你看到的就是 agent 看到的。' },
      { q: 'agent 能使用浏览器卡片吗？', a: '能。浏览器卡片是通过 DevTools 协议驱动的 Chromium 页面；agent 可以用 cookrew browser 命令导航、点击、填写和读取。' }
    ]
  },
  harnesses: {
    title: '在一个团队里运行 Claude Code、Codex、OpenCode 和 Pi',
    short: 'Claude Code、Codex、OpenCode、Pi 和普通 shell 作为预设提供。每个都可以用自己的登录运行，或经你自己的 Magpie 网关运行。',
    definition:
      'harness 是 Cookrew 知道如何托管、观察和派活的 agent CLI。Claude Code、Codex、OpenCode 和 Pi 作为预设提供；每个都在 Cookrew 的注册表里声明自己的能力，所以无论谁来回答，编排用的都是同一套命令行。',
    pts: ['选一个预设，点一下画布，队友启动，卡片打开', '所有 harness 共用一套 CLI；编排者不在乎谁来回答', '回合追踪直接来自 harness 本身，报告思考中、等待中、已回复，不靠抓屏', '每个 harness 可经你自己的 Magpie 网关路由，也可以用它自己的登录直接运行'],
    faq: [{ q: '能添加 Cookrew 没有提供的 harness 吗？', a: 'harness 是注册表里的一条记录，声明它如何启动、如何识别回合、能做什么。新增 harness 在那里完成，无需改动调用方。' }]
  },
  checkpoints: {
    title: '每个 agent 回合都是检查点：拖动、分叉、回退',
    short: '在会话里来回拖动，从任意过去的回合分叉出新 agent；原会话永远不受影响。',
    definition: ZH_CHECKPOINT_DEFINITION,
    pts: ['实时终端旁的轨道按到达顺序列出每个回合', '按住轨道拖动：对话记录随你回溯；拖得够远，检查点会展开成带标题的回合列表', '从第 N 个回合分叉；原会话继续运行', '历史追踪：每个检查点都带着 agent 实际产出的内容块'],
    faq: [
      { q: '分叉或导出时，我的会话会怎样？', a: '什么也不会发生。分叉和导出都从检查点复制；原会话从不被改动。' },
      { q: '检查点从哪里来？', a: '来自 harness 自己的会话记录：Cookrew 读取 agent 写下的对话记录，所以检查点就是 agent 眼中的那个回合，而不是屏幕截取。' }
    ]
  },
  board: {
    title: '跨机器、跨工作空间，一眼看清每个 agent 的状态',
    short: '退到你的机器这一层，每个工作空间显示它有几个 agent；进入其中一个，每个 agent 的状态写在它的名字下面。',
    definition:
      'Cookrew 的机群视图是缩放的最顶层：每台机器及其工作空间、每个工作空间里有几个 agent；进入工作空间后，每个 agent 的状态——工作中、已完成、休息中、离线或在等你——写在它的名字下面。红色只留给正在等你的 agent。',
    pts: ['机器、工作空间、团队：每一层点一下', '每个 agent 显示工作中、已完成、休息中、离线或等待中', '红色只留给正在等你的 agent', '命令框把所有等你处理的事集中在一个列表里'],
    faq: [{ q: '机群视图会显示离线的 agent 吗？', a: '会。没有实时窗格的 agent 在名字下显示为离线；它的历史依然在。' }]
  },
  cli: {
    title: '用一条命令行编排编程 agent',
    short: '人和 agent 共用一套 CLI。你能敲的命令，负责编排的 agent 也能敲。',
    definition:
      'cookrew CLI 是人和 agent 共用的唯一接口：招募队友、连接两张卡片、向 agent 提问并等待回复、读取它的状态、从某个回合分叉、保存团队、从模板创建工作空间。负责编排的 agent 运行的就是你用的那些命令。',
    pts: ['recruit、connect、ask、status、fork、team save、workspace create', 'ask 会等待并返回回复；status 显示思考中、等待中、已回复或空闲', '保存的团队把节点、连线和回合历史存进一个文件', '每个 harness 上的每个 agent 都响应同一套命令'],
    faq: [{ q: '一个 agent 能编排其他 agent 吗？', a: '能。把一个 agent 设为工作空间的编排者（orch），它就能像人一样招募、连接、提问和读取状态——这正是“指挥官带队”成为一种原生工作方式的原因。' }]
  },
  mobile: {
    title: '在手机上管理你的 agent：控制台，或同一 Wi-Fi 下的伴侣页面',
    short: '在手机浏览器里打开控制台，你账号下的每台机器都在：团队、卡片、对话记录和回复框。在同一个 Wi-Fi 下，扫二维码即可打开伴侣页面。',
    definition:
      '手机有两种方式连到你的 agent。登录后，控制台可以在任何手机浏览器、任何网络里打开，包含你账号下的每台机器。在同一个 Wi-Fi 或 Tailscale 下，扫二维码即可打开由桌面应用托管的伴侣页面：同样的缩放视图，用手指操作——团队、卡片、带轨道的完整对话记录——支持语音输入和语音播报回复，每个工作空间有固定的地址，可以加书签。',
    pts: ['控制台：任何手机浏览器、任何网络、你账号下的每台机器', '伴侣页面：cookrew mobile 在你的 Wi-Fi 或 Tailscale 下打印二维码', '同样的缩放视图，用手指操作：团队、卡片、对话记录', '语音输入，语音播报回复'],
    faq: [{ q: '手机需要安装应用吗？', a: '不需要。控制台和伴侣页面都是网页；手机用浏览器打开任何一个即可。' }]
  },
  workspaces: {
    title: '工作空间与保存的团队：一个项目，一个团队',
    short: '切换工作空间就切换了整个团队和整张画布。从保存的模板创建一个工作空间，整个团队立即就位。',
    definition:
      'Cookrew 工作空间是一个项目目录，有它自己的画布、团队和历史。保存的团队是由节点、连线和回合历史组成的模板；cookrew workspace create --team 会立即把保存的阵容投入一个新目录开始工作。',
    pts: ['一个工作空间就是一个项目目录，有自己的画布、团队和历史', 'workspace create --team 让保存的阵容立即开工', '每台机器的每个工作空间都列在控制台里'],
    faq: [{ q: '保存的团队里有什么？', a: '它的卡片、卡片之间的连线以及它们的回合历史，都在一个文件里。保存团队从不改动原会话。' }]
  },
  marketplace: {
    title: 'agent 团队市场：在应用里打开别人的团队',
    short: '市场列出的是入口，不是副本。团队始终留在作者的机器上；你登录、若收费则一次性购买席位，就得到一个属于你自己的实时沙箱会话。',
    definition: ZH_MARKET_DEFINITION,
    pts: ['一个 cookrew.dev 链接：在作者那边提供服务，在你这边打开', '中继只转发它读不懂的字节；作者可以随时结束会话', '200 已签名交付 · 401 需登录 · 402 需付款 · 403 不在范围内——钱直接付给作者', '放到画布上的卡片就是团队自己的终端，和作者看到的是同一个 PTY'],
    faq: [
      { q: '团队作者能看到我输入的内容吗？', a: '能。会话运行在作者的机器上，所以作者能看到你发送的内容以及他们的 agent 如何处理，也能结束会话。中间的中继读不了这些内容。' },
      { q: '提供服务的团队能访问我电脑上的什么？', a: '既不能访问文件也不能访问程序：它在作者机器上的沙箱里运行，应用只转发按键和屏幕字节。和任何终端一样，你在它卡片里选中的文字会被复制到剪贴板，所以团队可以往剪贴板里放文字；但它读不了你的剪贴板。' }
    ]
  }
}

export const ZH_START_HOWTO = [
  {
    name: '放一个 agent，让它编排你的工作流',
    text: '安装 Cookrew，在窗口底部的输入框里写下你想做的事：没有指定对象时，它会启动一个新 agent——Claude Code、Codex、OpenCode 或 Pi——并根据你写的内容给它命名。把这个 agent 设为编排者（orch）。它会用和你相同的 CLI 招募队友、放置便签、打开浏览器；你在轨道上阅读回复。',
    detail: [
      'cookrew orch "Forge" —— 一个 agent 是入口，其余是它的团队',
      '对它说：“招募一个用 Codex 的审查者，放一张写规格的便签，开一个文档浏览器”——它会运行 cookrew recruit、connect、note create、browser create',
      '每个回合都作为检查点落在卡片的轨道上；cookrew status 会告诉你思考中、等待中还是已回复'
    ]
  },
  {
    name: '保存团队，用它开始下一个项目',
    text: '选中卡片，保存团队：节点、连线和回合历史存进一个文件，原会话不受影响。用它创建下一个工作空间，整个团队立即就位。',
    detail: ['cookrew team save "MY CREW"', 'cookrew workspace create "Next project" --team "MY CREW"', '在控制台里、在你账号下的任何机器上跟进新团队']
  }
]

export const ZH_START_FAQ = [
  { q: '安装 Cookrew 前需要准备什么？', a: '一台 Apple Silicon 的 Mac 或一台 Windows 电脑；如果从源码构建需要 Node 20+；用于托管终端的 tmux 或 herdr；以及你想运行的 agent CLI（Claude Code、Codex、OpenCode、Pi）和它们各自的登录。' },
  { q: '使用 Cookrew 需要账号吗？', a: '不需要。应用完全在你的机器上运行。只有想从控制台访问你的机器时，才需要一个 cookrew.dev 账号。' }
]


