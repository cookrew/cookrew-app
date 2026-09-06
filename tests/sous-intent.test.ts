import { describe, expect, it } from 'vitest'
import { parseUtterance, resolveName, type IntentContext, type IntentRoster } from '../src/shared/sous-intent'

// The roster every sentence in the owner's ask resolves against. Two
// workspaces, a Conductor in each — that duplicate is deliberate, it is the
// ambiguity the parser must refuse to guess through.
const roster: IntentRoster = {
  agents: [
    { id: 'a-cond', name: 'Conductor', workspaceId: 'ws-dev', workspaceName: 'cookrew dev', aliases: ['指挥'] },
    { id: 'a-cc', name: 'claude-code', workspaceId: 'ws-dev', workspaceName: 'cookrew dev' },
    { id: 'a-paul', name: 'Paul', workspaceId: 'ws-dev', workspaceName: 'cookrew dev' },
    { id: 'a-cond2', name: 'Conductor', workspaceId: 'ws-mall', workspaceName: 'agentmall' },
    { id: 'a-magpie', name: 'Magpie', workspaceId: 'ws-mall', workspaceName: 'agentmall' }
  ],
  workspaces: [
    { id: 'ws-dev', name: 'cookrew dev' },
    { id: 'ws-mall', name: 'agentmall' }
  ],
  presets: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell']
}

const canvas: IntentContext = { surface: 'canvas', activeWorkspaceId: 'ws-dev' }
const zoom: IntentContext = { surface: 'zoom', activeWorkspaceId: 'ws-dev', focusedAgentId: 'a-cc' }
const home: IntentContext = { surface: 'home', activeWorkspaceId: 'ws-mall' }

const NOW = 1_000_000

describe('resolveName', () => {
  const pool = [
    { id: '1', name: 'Conductor', aliases: ['指挥'] },
    { id: '2', name: 'Codex' },
    { id: '3', name: 'Codex QA' }
  ]
  it('matches exactly, ignoring case, spaces, dashes and underscores', () => {
    expect(resolveName('conductor', pool)).toEqual({ hit: pool[0] })
    expect(resolveName('codex_qa', pool)).toEqual({ hit: pool[2] })
  })
  it('matches an alias — how a Chinese sentence names an English agent', () => {
    expect(resolveName('指挥', pool)).toEqual({ hit: pool[0] })
  })
  it('accepts a unique prefix and refuses an ambiguous one', () => {
    expect(resolveName('cond', pool)).toEqual({ hit: pool[0] })
    expect(resolveName('code', pool)).toEqual({ ambiguous: [pool[1], pool[2]] })
  })
  it('an exact hit beats the prefix it also is', () => {
    expect(resolveName('codex', pool)).toEqual({ hit: pool[1] })
  })
  it('misses plainly', () => {
    expect(resolveName('Sam', pool)).toEqual({ miss: true })
    expect(resolveName('', pool)).toEqual({ miss: true })
  })
})

describe('switch', () => {
  it.each([
    '切换工作台到cookrew dev',
    '切换到 cookrew dev',
    '切到cookrew dev',
    'switch to cookrew dev',
    'go to workspace cookrew dev',
    'switch cookrew dev'
  ])('%s → switch ws-dev', (said) => {
    const r = parseUtterance(said, home, roster, NOW)
    expect(r).toMatchObject({ ok: true, intent: { kind: 'switch', workspaceId: 'ws-dev' } })
  })
  it('speaks in the language of the sentence', () => {
    expect(parseUtterance('切换工作台到cookrew dev', home, roster, NOW)).toMatchObject({ spoken: '好的，切到 cookrew dev' })
    expect(parseUtterance('switch to agentmall', canvas, roster, NOW)).toMatchObject({ spoken: 'Switching to agentmall' })
  })
  it('an unknown workspace is refused in words, not guessed', () => {
    expect(parseUtterance('switch to narnia', canvas, roster, NOW)).toMatchObject({
      ok: false,
      needs: 'unknown-workspace',
      spoken: 'No workspace named narnia'
    })
  })
})

describe('ask', () => {
  it('“帮我问问Conductor” in the active workspace asks back for the prompt', () => {
    const r = parseUtterance('帮我问问Conductor', canvas, roster, NOW)
    expect(r).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-cond', prompt: null },
      spoken: '需要问 Conductor 什么呢？'
    })
  })
  it('“ask Conductor on cookrew dev” names the workspace and so picks that Conductor', () => {
    const r = parseUtterance('ask Conductor on cookrew dev', home, roster, NOW)
    expect(r).toMatchObject({ ok: true, intent: { kind: 'ask', agentId: 'a-cond', prompt: null } })
  })
  it('“turn to Conductor” with no workspace named prefers the active one', () => {
    expect(parseUtterance('turn to Conductor', home, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-cond2' }
    })
  })
  it('a name that lives only elsewhere still resolves — it means switching first', () => {
    expect(parseUtterance('ask Magpie', canvas, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-magpie' }
    })
  })
  it('a name duplicated across workspaces with no active hit asks which', () => {
    const noActive: IntentContext = { surface: 'cli', activeWorkspaceId: null }
    expect(parseUtterance('ask Conductor', noActive, roster, NOW)).toMatchObject({
      ok: false,
      needs: 'which-agent',
      choices: ['Conductor (cookrew dev)', 'Conductor (agentmall)']
    })
  })
  it('carries an inline prompt', () => {
    expect(parseUtterance('问问Conductor，把测试跑一遍', canvas, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-cond', prompt: '把测试跑一遍' },
      spoken: '已发给 Conductor'
    })
    expect(parseUtterance('ask Paul: run the tests', canvas, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-paul', prompt: 'run the tests' }
    })
  })
  it('the alias 指挥 reaches Conductor', () => {
    expect(parseUtterance('帮我问问指挥', canvas, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'ask', agentId: 'a-cond' }
    })
  })
  it('an unknown agent is refused in words', () => {
    expect(parseUtterance('turn to Sam', canvas, roster, NOW)).toMatchObject({
      ok: false,
      needs: 'unknown-agent',
      spoken: 'No agent named Sam'
    })
  })
})

describe('the pending prompt slot', () => {
  const pending: IntentContext = { ...home, pending: { kind: 'prompt', agentId: 'a-cond', until: NOW + 25_000 } }
  it('the next sentence becomes the prompt for the agent asked about', () => {
    expect(parseUtterance('帮我写今日打卡发到小红书', pending, roster, NOW + 1000)).toMatchObject({
      ok: true,
      intent: { kind: 'prompt', agentId: 'a-cond', text: '帮我写今日打卡发到小红书' },
      spoken: '已发给 Conductor'
    })
  })
  it('a control sentence still wins over the slot', () => {
    expect(parseUtterance('切换到 agentmall', pending, roster, NOW + 1000)).toMatchObject({
      intent: { kind: 'switch' }
    })
  })
  it('an expired slot is not a slot', () => {
    expect(parseUtterance('帮我写今日打卡发到小红书', pending, roster, NOW + 60_000)).toMatchObject({
      ok: true,
      intent: { kind: 'none' }
    })
  })
})

describe('the zoom view', () => {
  it('plain speech is a prompt for the focused agent', () => {
    expect(parseUtterance('add a retry around the fetch', zoom, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'prompt', agentId: 'a-cc', text: 'add a retry around the fetch' }
    })
  })
  it('a sentence addressed to Sous is a command, not a prompt', () => {
    expect(parseUtterance('Sous, back to canvas', zoom, roster, NOW)).toMatchObject({ intent: { kind: 'back' } })
    expect(parseUtterance('苏斯，回到画布', zoom, roster, NOW)).toMatchObject({ intent: { kind: 'back' } })
  })
  it('a sentence that merely begins with the word Sous is prose, sent whole', () => {
    expect(parseUtterance('Sous vide is a technique, add a class for it', zoom, roster, NOW)).toMatchObject({
      intent: { kind: 'prompt', agentId: 'a-cc', text: 'Sous vide is a technique, add a class for it' }
    })
  })
  it('a sentence that looks like a control verb but is not addressed to Sous stays a prompt', () => {
    // "rename the variable to count" is something you say TO an agent.
    expect(parseUtterance('rename foo to bar', zoom, roster, NOW)).toMatchObject({
      intent: { kind: 'prompt', text: 'rename foo to bar' }
    })
  })
})

describe('create', () => {
  it('“create claude-code on cookrew dev with a browser”', () => {
    expect(parseUtterance('create claude-code on cookrew dev with a browser', home, roster, NOW)).toMatchObject({
      ok: true,
      intent: { kind: 'create', preset: 'Claude Code', workspaceId: 'ws-dev', browser: true },
      spoken: 'Created Claude Code on cookrew dev with a browser'
    })
  })
  it('the browser clause may come before the workspace', () => {
    expect(parseUtterance('create codex with a browser on agentmall', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'create', preset: 'Codex', workspaceId: 'ws-mall', browser: true }
    })
  })
  it('在agentmall创建codex带浏览器', () => {
    expect(parseUtterance('在agentmall创建codex带浏览器', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'create', preset: 'Codex', workspaceId: 'ws-mall', browser: true },
      spoken: '建好了，Codex 在 agentmall，带浏览器'
    })
  })
  it('no workspace named means the active one, and no browser means none', () => {
    expect(parseUtterance('新建一个 claude code', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'create', preset: 'Claude Code', workspaceId: null, browser: false }
    })
  })
  it('an unknown preset is refused in words', () => {
    expect(parseUtterance('create gemini on cookrew dev', canvas, roster, NOW)).toMatchObject({
      ok: false,
      needs: 'unknown-preset',
      spoken: 'No preset named gemini'
    })
  })
})

describe('connect and rename', () => {
  it('link claude-code to Paul', () => {
    expect(parseUtterance('link claude-code to Paul', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'connect', fromId: 'a-cc', toId: 'a-paul' },
      spoken: 'Connected claude-code and Paul'
    })
    expect(parseUtterance('把 claude-code 连到 Paul', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'connect', fromId: 'a-cc', toId: 'a-paul' },
      spoken: '已连接 claude-code 和 Paul'
    })
  })
  it('rename claude-code to Paul', () => {
    expect(parseUtterance('rename claude-code to Paul', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'rename', agentId: 'a-cc', to: 'Paul' },
      spoken: 'claude-code is now Paul'
    })
    expect(parseUtterance('把 claude-code 改名为 保罗', canvas, roster, NOW)).toMatchObject({
      intent: { kind: 'rename', agentId: 'a-cc', to: '保罗' },
      spoken: 'claude-code 现在叫 保罗'
    })
  })
  it('a rename to nothing, or to something absurdly long, is refused', () => {
    expect(parseUtterance('rename Paul to   ', canvas, roster, NOW)).toMatchObject({ ok: false, needs: 'bad-name' })
    expect(parseUtterance(`rename Paul to ${'x'.repeat(80)}`, canvas, roster, NOW)).toMatchObject({
      ok: false,
      needs: 'bad-name'
    })
  })
})

describe('back, open, none', () => {
  it.each(['回到画布', 'back', 'back to canvas', 'zoom out'])('%s → back', (said) => {
    expect(parseUtterance(said, canvas, roster, NOW)).toMatchObject({ intent: { kind: 'back' } })
  })
  it.each(['帮我打开cookrew', 'open cookrew', '打开 Cookrew'])('%s → open', (said) => {
    expect(parseUtterance(said, home, roster, NOW)).toMatchObject({ intent: { kind: 'open' }, spoken: expect.any(String) })
  })
  it('anything else on the canvas is none — the caller may try the model, never a shell', () => {
    expect(parseUtterance('小爱同学开灯', home, roster, NOW)).toMatchObject({ ok: true, intent: { kind: 'none' } })
    expect(parseUtterance('', canvas, roster, NOW)).toMatchObject({ ok: true, intent: { kind: 'none' } })
  })
})
