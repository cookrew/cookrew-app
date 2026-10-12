import type { CardRouteState, RouteState } from './route'

/**
 * A plausible route state for the demo api, the preview fixture and the
 * render tests — the online picture the panel was drawn from, shaped the
 * way the real gateway (magpie 0.1.1182, report-e2e.md) answers: a quota
 * row the gateway could not read, a ready-made window label, a local
 * provider synthesised from the catalogue, an email on a real account, a
 * decision with its first-token time, a local turn with no price. Main
 * never reads this; it exists so the renderer can be built and photographed
 * without a Magpie on the machine.
 */

export const SETUP_LINES: RouteState['setup'] = {
  installLine: 'curl -fsSL https://usemagpie.ai/install.sh | sh',
  serveLine: 'magpie autostart on',
  pluginLine: "magpie plugin add '/Applications/Cookrew Dev.app/Contents/Resources/magpie'",
  addSubscriptionLine: 'magpie accounts add codex',
  addKeyLine: 'magpie provider add ',
  addLocalLine: 'magpie provider add ollama',
  addGroupLine: 'magpie group add smart models=claude/claude-sonnet-5,codex/gpt-5.5,deepseek/deepseek-v4 routing=smart'
}

const NOW = 1_791_000_000_000

export function routeFixture(status: RouteState['status'] = 'online', over: Partial<RouteState> = {}): RouteState {
  const online = status === 'online'
  return {
    status,
    gateway: status === 'absent' ? null : { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', port: 3425, version: '0.1.1182', source: 'plugin' },
    why: null,
    defaultModel: online ? 'group/smart' : null,
    providers: online ? 3 : 0,
    models: online
      ? [
          { id: 'group/smart', displayName: 'smart', ownedBy: 'magpie', group: true, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: null },
          { id: 'group/opus-anywhere', displayName: 'Opus anywhere', ownedBy: 'magpie', group: true, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: null },
          { id: 'claude/claude-opus-5-5', displayName: 'Claude Opus 5.5', ownedBy: 'claude', group: false, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: 400_000 },
          { id: 'claude/claude-sonnet-5', displayName: 'Claude Sonnet 5', ownedBy: 'claude', group: false, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: 400_000 },
          { id: 'codex/gpt-5.5', displayName: 'GPT-5.5', ownedBy: 'codex', group: false, reasoning: true, levels: ['low', 'medium', 'high', 'xhigh'], contextWindow: 272_000 },
          { id: 'deepseek/deepseek-v4', displayName: 'DeepSeek V4', ownedBy: 'deepseek', group: false, reasoning: false, levels: [], contextWindow: 128_000 },
          { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', ownedBy: 'deepseek', group: false, reasoning: false, levels: [], contextWindow: 128_000 },
          { id: 'ollama/qwen3:32b', displayName: 'qwen3:32b', ownedBy: 'ollama', group: false, reasoning: false, levels: [], contextWindow: 32_000 }
        ]
      : [],
    quotas: online
      ? [
          // The gateway could not read this one: a sentence, no bar.
          { provider: 'claude', account: 'drej@example.com', alias: 'Claude Max', plan: 'Max', kind: 'subscription', windows: [], last: true, error: "Claude Code's /usage is temporarily unavailable" },
          // Real windows carry the gateway's own label and no reset time.
          { provider: 'codex', account: 'drej@example.com', alias: 'ChatGPT Plus', plan: 'Plus', kind: 'subscription', windows: [{ name: '5h', used: 0, limit: 130, resetsAt: null, display: '0 / 130' }, { name: 'week', used: 77, limit: 100, resetsAt: null, display: '77 / 100' }], last: false, error: null },
          { provider: 'deepseek', account: null, alias: 'DeepSeek', plan: null, kind: 'key', windows: [], last: false, error: null },
          // Synthesised from the catalogue: a local provider has no quota.
          { provider: 'ollama', account: null, alias: null, plan: null, kind: 'local', windows: [], last: false, error: null }
        ]
      : [],
    live: online
      ? [
          { terminalId: 'forge', session: 'cookrew:forge', seq: 12, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: 'high', tries: 1, done: true, status: null, at: NOW - 48_000, ttftMs: 2_300, ms: 14_800 , rule: null},
          { terminalId: 'tinker', session: 'cookrew:tinker', seq: 7, asked: 'group/smart', group: 'group/smart', model: 'codex/gpt-5.5', effort: 'medium', tries: 1, done: true, status: null, at: NOW - 80_000, ttftMs: 820, ms: 6_200 , rule: null},
          { terminalId: 'orch', session: 'cookrew:orch', seq: 31, asked: 'claude/claude-opus-5-5', group: null, model: 'claude/claude-opus-5-5', effort: 'high', tries: 1, done: true, status: null, at: NOW - 177_000, ttftMs: null, ms: null , rule: null},
          { terminalId: 'prune', session: 'cookrew:prune', seq: 2, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: null, tries: 2, done: true, status: 'claude rested · 429', at: NOW - 245_000, ttftMs: 4_100, ms: 22_000 , rule: null},
          { terminalId: 'fresco', session: 'cookrew:fresco', seq: 9, asked: 'group/opus-anywhere', group: 'group/opus-anywhere', model: 'copilot/claude-opus-5.5', effort: 'high', tries: 1, done: true, status: 'claude/opus at 98%', at: NOW - 470_000, ttftMs: 1_050, ms: null , rule: null}
        ]
      : [],
    harnesses: [
      { id: 'claude', name: 'Claude Code', installed: true, signedIn: true, inDock: true, installLine: 'npm i -g @anthropic-ai/claude-code', loginLine: 'claude', routable: true },
      { id: 'codex', name: 'Codex', installed: true, signedIn: online, inDock: true, installLine: 'npm i -g @openai/codex', loginLine: 'codex login', routable: true },
      { id: 'opencode', name: 'OpenCode', installed: false, signedIn: null, inDock: false, installLine: 'curl -fsSL https://opencode.ai/install | bash', loginLine: 'opencode auth login', routable: true },
      { id: 'pi', name: 'Pi', installed: true, signedIn: null, inDock: false, installLine: 'npm i -g @earendil-works/pi-coding-agent', loginLine: null, routable: true }
    ],
    checkedAt: NOW,
    setup: SETUP_LINES,
    ...over
  }
}

export function cardRouteFixture(over: Partial<CardRouteState> = {}): CardRouteState {
  return {
    route: 'group/smart',
    effective: 'deepseek/deepseek-v4',
    appliesOn: 'now',
    live: { terminalId: 'forge', session: 'cookrew:forge', seq: 12, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: 'high', tries: 1, done: true, status: null, at: NOW - 48_000, ttftMs: 2_300, ms: 14_800 , rule: null},
    turn: { model: 'deepseek/deepseek-v4', inputTokens: 11_300, outputTokens: 1_100, cost: 0.018, priced: true, at: NOW - 40_000 },
    offline: false,
    note: null,
    gateway: 'online',
    routable: true,
    ...over
  }
}

/** A turn on a local model: tokens counted, nothing priced. */
export function localTurnFixture(): CardRouteState {
  return cardRouteFixture({
    route: 'ollama/qwen3:32b',
    effective: 'ollama/qwen3:32b',
    live: null,
    turn: { model: 'ollama/qwen3:32b', inputTokens: 1_840, outputTokens: 312, cost: null, priced: false, at: NOW - 5_000 }
  })
}
