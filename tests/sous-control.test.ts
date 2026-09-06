import { describe, expect, it } from 'vitest'
import { SousController, type SousControlDeps } from '../src/main/sous-control'
import { PENDING_PROMPT_MS, type IntentRoster } from '../src/shared/sous-intent'

const roster: IntentRoster = {
  agents: [
    { id: 'a-cond', name: 'Conductor', workspaceId: 'ws-dev', workspaceName: 'cookrew dev' },
    { id: 'a-cc', name: 'claude-code', workspaceId: 'ws-dev', workspaceName: 'cookrew dev' },
    { id: 'a-paul', name: 'Paul', workspaceId: 'ws-dev', workspaceName: 'cookrew dev' },
    { id: 'a-cond2', name: 'Conductor', workspaceId: 'ws-mall', workspaceName: 'agentmall' },
    { id: 'a-magpie', name: 'Magpie', workspaceId: 'ws-mall', workspaceName: 'agentmall' }
  ],
  workspaces: [
    { id: 'ws-dev', name: 'cookrew dev' },
    { id: 'ws-mall', name: 'agentmall' }
  ],
  presets: ['Claude Code', 'Codex', 'Shell']
}

/** Every dep records its call; the tests read the trail. */
function harness(options: { active?: string | null; failing?: string; polish?: (t: string) => string | null } = {}) {
  const calls: string[] = []
  let active: string | null = options.active === undefined ? 'ws-dev' : options.active
  let clock = 1_000_000
  const deps: SousControlDeps = {
    roster: () => roster,
    activeWorkspaceId: () => active,
    switchWorkspace: (id) => {
      calls.push(`switch ${id}`)
      active = id
    },
    createTerminal: ({ preset, name }) => {
      calls.push(`create ${preset} as ${name}`)
      if (options.failing === 'create') throw new Error('no room')
      return { id: 'a-new', name }
    },
    createBrowser: async (anchor, name) => {
      calls.push(`browser ${anchor} ${name}`)
    },
    connect: (a, b) => calls.push(`connect ${a} ${b}`),
    rename: (id, name) => calls.push(`rename ${id} ${name}`),
    submit: async (id, text, { enter }) => {
      calls.push(`${enter ? 'submit' : 'type'} ${id} ${text}`)
      if (options.failing === 'submit') throw new Error('input box is busy')
    },
    ...(options.polish
      ? {
          polish: async (text: string) => {
            calls.push(`polish ${text}`)
            const out = options.polish?.(text) ?? null
            return out === null ? { text, polished: false } : { text: out, polished: true }
          }
        }
      : {}),
    ui: (command, workspaceId) =>
      calls.push(`ui ${command.kind}${'nodeId' in command ? ` ${command.nodeId}` : ''} @${workspaceId}`),
    note: (kind, id, detail) => calls.push(`note ${kind} ${id ?? '-'} ${detail}`),
    now: () => clock
  }
  return { calls, deps, controller: new SousController(deps), tick: (ms: number) => (clock += ms) }
}

describe('switch', () => {
  it('switches, then brings the canvas back to the overview of the new workspace', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'switch to agentmall', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'switch', spoken: 'Switching to agentmall' })
    expect(h.calls).toEqual(['switch ws-mall', 'ui zoom-back @ws-mall', 'note switch ws-mall agentmall'])
  })
  it('does not re-switch to the workspace already active', async () => {
    const h = harness()
    await h.controller.handle({ text: '切换到 cookrew dev', surface: 'home' })
    expect(h.calls).toEqual(['ui zoom-back @ws-dev', 'note switch ws-dev cookrew dev'])
  })
})

describe('ask', () => {
  it('an agent elsewhere means switching first, then zoom and focus, then the question back', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'ask Magpie', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'ask', needs: 'prompt', agentId: 'a-magpie', spoken: 'What should I ask Magpie?' })
    expect(h.calls).toEqual([
      'switch ws-mall',
      'ui zoom a-magpie @ws-mall',
      'ui focus-input a-magpie @ws-mall',
      'note ask a-magpie Magpie'
    ])
  })
  it('the next sentence on the same surface is the prompt; another surface is not', async () => {
    const h = harness()
    await h.controller.handle({ text: '帮我问问Conductor', surface: 'home' })
    const other = await h.controller.handle({ text: '帮我写今日打卡发到小红书', surface: 'phone' })
    expect(other).toMatchObject({ intent: 'none' })
    const answer = await h.controller.handle({ text: '帮我写今日打卡发到小红书', surface: 'home' })
    expect(answer).toMatchObject({ intent: 'prompt', spoken: '已发给 Conductor', agentId: 'a-cond' })
    expect(h.calls.at(-2)).toBe('submit a-cond 帮我写今日打卡发到小红书')
    expect(h.controller.pendingFor('home')).toBeNull()
  })
  it('two phones are two callers: one phone cannot answer the question Sous asked the other', async () => {
    const h = harness()
    await h.controller.handle({ text: 'ask Paul', surface: 'phone', callerId: 'phone-a' })
    const other = await h.controller.handle({ text: 'run the tests', surface: 'phone', callerId: 'phone-b' })
    expect(other).toMatchObject({ intent: 'none' })
    const mine = await h.controller.handle({ text: 'run the tests', surface: 'phone', callerId: 'phone-a' })
    expect(mine).toMatchObject({ intent: 'prompt', agentId: 'a-paul' })
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual(['submit a-paul run the tests'])
  })
  it('a network door gets no focus it did not earn: zoom prose goes nowhere until Sous itself zoomed that caller', async () => {
    const h = harness()
    const cold = await h.controller.handle({ text: 'add a retry', surface: 'zoom', callerId: 'speaker-1' })
    expect(cold).toMatchObject({ intent: 'none' })
    await h.controller.handle({ text: 'Sous, ask Paul: hello', surface: 'zoom', callerId: 'speaker-1' })
    const warm = await h.controller.handle({ text: 'add a retry', surface: 'zoom', callerId: 'speaker-1' })
    expect(warm).toMatchObject({ intent: 'prompt', agentId: 'a-paul' })
    // …and another caller on the same surface still has none.
    const stranger = await h.controller.handle({ text: 'add a retry', surface: 'zoom', callerId: 'speaker-2' })
    expect(stranger).toMatchObject({ intent: 'none' })
    // Zoom surface: typed and left, never submitted — the owner sends.
    expect(h.calls.filter((c) => c.startsWith('type'))).toEqual(['type a-paul hello', 'type a-paul add a retry'])
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
  })
  it('leaving the zoom forgets the focus', async () => {
    const h = harness()
    await h.controller.handle({ text: 'Sous, ask Paul: hello', surface: 'zoom', callerId: 'speaker-1' })
    await h.controller.handle({ text: 'Sous, back', surface: 'zoom', callerId: 'speaker-1' })
    const after = await h.controller.handle({ text: 'add a retry', surface: 'zoom', callerId: 'speaker-1' })
    expect(after).toMatchObject({ intent: 'none' })
  })
  it('a slot expires', async () => {
    const h = harness()
    await h.controller.handle({ text: 'ask Paul', surface: 'home' })
    h.tick(PENDING_PROMPT_MS + 1)
    expect(h.controller.pendingFor('home')).toBeNull()
    const late = await h.controller.handle({ text: 'do the thing', surface: 'home' })
    expect(late).toMatchObject({ intent: 'none' })
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
  })
  it('an inline prompt is submitted at once, with no slot left behind', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'ask Paul: run the tests', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'ask', spoken: 'Sent to Paul' })
    expect(h.calls).toContain('submit a-paul run the tests')
    expect(h.controller.pendingFor('canvas')).toBeNull()
  })
})

describe('two ears', () => {
  it('when the zh ear mangles a name, the en ear\'s transcript of the same audio is used', async () => {
    const h = harness()
    const r = await h.controller.handle({
      text: '帮我问问双球',
      alternates: ['ask Conductor'],
      surface: 'canvas'
    })
    expect(r).toMatchObject({ intent: 'ask', agentId: 'a-cond', needs: 'prompt' })
  })
  it('the primary wins whenever it resolved on its own', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: '帮我问问 Paul', alternates: ['ask Magpie'], surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'ask', agentId: 'a-paul' })
  })
  it('dictation is never swapped for an alternate — prose is the primary\'s words', async () => {
    const h = harness()
    const r = await h.controller.handle({
      text: '给 fetch 加一个重试',
      alternates: ['ask Paul'],
      surface: 'zoom',
      focusedAgentId: 'a-cc'
    })
    expect(r).toMatchObject({ intent: 'prompt', agentId: 'a-cc', text: '给 fetch 加一个重试' })
  })
  it('a refusal that asks which stays a refusal — the alternate is not used to guess', async () => {
    const h = harness({ active: null })
    const r = await h.controller.handle({ text: 'ask Conductor', alternates: ['ask Paul'], surface: 'cli' })
    expect(r).toMatchObject({ intent: 'refused', needs: 'which-agent' })
  })
})

describe('the zoom view — dictation, Typeless style', () => {
  it('plain speech is typed into the agent on screen and LEFT there: the owner sends', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'add a retry around the fetch', surface: 'zoom', focusedAgentId: 'a-cc' })
    expect(r).toMatchObject({
      intent: 'prompt',
      agentId: 'a-cc',
      text: 'add a retry around the fetch',
      spoken: "In claude-code's box — Enter sends"
    })
    expect(h.calls).toEqual(['type a-cc add a retry around the fetch', 'note typed a-cc claude-code'])
  })
  it('thinking aloud is cleaned up before it lands, and the result says so', async () => {
    const h = harness({ polish: () => '帮我写一个今日打卡，发到朋友圈。' })
    const said = '嗯那个帮我写一个今日打卡然后发到小红书，不对，发到朋友圈'
    const r = await h.controller.handle({ text: said, surface: 'zoom', focusedAgentId: 'a-cc' })
    expect(r).toMatchObject({
      intent: 'prompt',
      text: '帮我写一个今日打卡，发到朋友圈。',
      polished: true,
      spoken: '已放进 claude-code 的输入框，回车发送'
    })
    expect(h.calls).toEqual([`polish ${said}`, 'type a-cc 帮我写一个今日打卡，发到朋友圈。', 'note typed a-cc claude-code'])
  })
  it('when Sous cannot clean it in time the words still land, raw', async () => {
    const h = harness({ polish: () => null })
    const r = await h.controller.handle({ text: 'um add a retry around the fetch', surface: 'zoom', focusedAgentId: 'a-cc' })
    expect(r).toMatchObject({ text: 'um add a retry around the fetch', polished: false })
    expect(h.calls).toContain('type a-cc um add a retry around the fetch')
  })
  it('from a speaker nobody can press Enter, so the cleaned prompt is submitted', async () => {
    const h = harness({ polish: () => 'Write a daily check-in and post it.' })
    await h.controller.handle({ text: 'ask Paul', surface: 'home', callerId: 'lx01' })
    const r = await h.controller.handle({ text: 'um write a daily check-in and, uh, post it', surface: 'home', callerId: 'lx01' })
    expect(r).toMatchObject({ intent: 'prompt', spoken: 'Sent to Paul', polished: true })
    expect(h.calls).toContain('submit a-paul Write a daily check-in and post it.')
  })
})

describe('create', () => {
  it('“create claude-code on cookrew dev with a browser” from the speaker on another workspace', async () => {
    const h = harness({ active: 'ws-mall' })
    const r = await h.controller.handle({ text: 'create claude-code on cookrew dev with a browser', surface: 'home' })
    expect(r).toMatchObject({ intent: 'create', agentId: 'a-new', spoken: 'Created Claude Code on cookrew dev with a browser' })
    expect(h.calls).toEqual([
      'switch ws-dev',
      'create Claude Code as Claude Code',
      'browser a-new Claude Code browser',
      'ui zoom a-new @ws-dev',
      'note create a-new Claude Code + browser'
    ])
  })
  it('no workspace named means here, no browser means none', async () => {
    const h = harness()
    await h.controller.handle({ text: '新建一个 codex', surface: 'canvas' })
    expect(h.calls).toEqual(['create Codex as Codex', 'ui zoom a-new @ws-dev', 'note create a-new Codex'])
  })
})

describe('connect, rename, back, open', () => {
  it('connect and rename call the store and leave a trail', async () => {
    const h = harness()
    await h.controller.handle({ text: 'link claude-code to Paul', surface: 'canvas' })
    await h.controller.handle({ text: 'rename claude-code to Sam', surface: 'canvas' })
    expect(h.calls).toEqual([
      'connect a-cc a-paul',
      'note connect a-cc claude-code ↔ Paul',
      'rename a-cc Sam',
      'note rename a-cc claude-code → Sam'
    ])
  })
  it('back leaves the zoom — addressed to Sous, since bare words there are prose for the agent', async () => {
    const h = harness()
    await h.controller.handle({ text: 'Sous, back', surface: 'zoom', focusedAgentId: 'a-cc' })
    expect(h.calls).toEqual(['ui zoom-back @ws-dev'])
    await h.controller.handle({ text: '帮我打开cookrew', surface: 'home' })
    expect(h.calls.slice(1)).toEqual(['ui zoom-back @ws-dev', 'note open - cookrew'])
  })
})

describe('refusals and failures never touch the canvas', () => {
  it('an ambiguous name is asked back and nothing runs', async () => {
    const h = harness({ active: null })
    const r = await h.controller.handle({ text: 'ask Conductor', surface: 'cli' })
    expect(r).toMatchObject({ intent: 'refused', needs: 'which-agent', choices: ['Conductor (cookrew dev)', 'Conductor (agentmall)'] })
    expect(h.calls).toEqual([])
  })
  it('an unknown preset is refused in words and nothing runs', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'create gemini', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'refused', needs: 'unknown-preset' })
    expect(h.calls).toEqual([])
  })
  it('a sentence that is not ours is none — free text never reaches anything but submit', async () => {
    const h = harness()
    const r = await h.controller.handle({ text: 'rm -rf / && echo done', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'none' })
    expect(h.calls).toEqual([])
  })
  it('a failing step becomes a spoken failure, not a throw, in the sentence language', async () => {
    const zh = harness({ failing: 'submit' })
    const r = await zh.controller.handle({ text: '问问Paul，跑一下测试', surface: 'canvas' })
    expect(r).toMatchObject({ intent: 'refused', spoken: '没做成：input box is busy' })
    const en = harness({ failing: 'create' })
    const c = await en.controller.handle({ text: 'create codex', surface: 'canvas' })
    expect(c).toMatchObject({ intent: 'refused', spoken: 'That did not work: no room' })
  })
})
