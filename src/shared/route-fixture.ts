import type { CardRouteState, RouteState } from './route'

/**
 * A plausible route state for the demo api, the preview fixture and the
 * render tests — the online picture the panel was drawn from. Main never
 * reads this; it exists so the renderer can be built and photographed before
 * the gateway probe lands and after it, without a Magpie on the machine.
 */

export const SETUP_LINES: RouteState['setup'] = {
  installLine: 'curl -fsSL https://usemagpie.ai/install.sh | sh',
  serveLine: 'magpie autostart on',
  pluginLine: 'magpie plugin add /Applications/Cookrew.app/Contents/Resources/magpie',
  addSubscriptionLine: 'magpie accounts add codex',
  addKeyLine: 'magpie provider add ',
  addLocalLine: 'magpie provider add ollama',
  addGroupLine: 'magpie group add smart models=claude/claude-sonnet-5,codex/gpt-5.5,deepseek/deepseek-v4 routing=smart'
}

const NOW = 1_791_000_000_000

export function routeFixture(status: RouteState['status'] = 'online'): RouteState {
  const online = status === 'online'
  return {
    status,
    gateway: status === 'absent' ? null : { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew', port: 3425, version: '0.9.3', source: 'plugin' },
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
          { provider: 'claude', account: 'drej@…', alias: 'Claude Max', plan: 'Max', kind: 'subscription', windows: [{ name: '5-hour', used: 62, limit: 100, resetsAt: NOW + 3_600_000 }, { name: 'week', used: 41, limit: 100, resetsAt: NOW + 86_400_000 * 3 }], last: true },
          { provider: 'codex', account: 'drej@…', alias: 'ChatGPT Plus', plan: 'Plus', kind: 'subscription', windows: [{ name: '5-hour', used: 18, limit: 100, resetsAt: NOW + 3_600_000 }, { name: 'week', used: 77, limit: 100, resetsAt: NOW + 86_400_000 }], last: false },
          { provider: 'deepseek', account: null, alias: 'DeepSeek', plan: null, kind: 'key', windows: [], last: false },
          { provider: 'ollama', account: null, alias: 'Ollama', plan: null, kind: 'local', windows: [], last: false }
        ]
      : [],
    live: online
      ? [
          { terminalId: 'forge', session: 'cookrew:forge', seq: 12, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: 'high', tries: 1, done: true, status: null, at: NOW - 48_000 },
          { terminalId: 'tinker', session: 'cookrew:tinker', seq: 7, asked: 'group/smart', group: 'group/smart', model: 'codex/gpt-5.5', effort: 'medium', tries: 1, done: true, status: null, at: NOW - 80_000 },
          { terminalId: 'orch', session: 'cookrew:orch', seq: 31, asked: 'claude/claude-opus-5-5', group: null, model: 'claude/claude-opus-5-5', effort: 'high', tries: 1, done: true, status: null, at: NOW - 177_000 },
          { terminalId: 'prune', session: 'cookrew:prune', seq: 2, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: null, tries: 2, done: true, status: 'claude rested · 429', at: NOW - 245_000 },
          { terminalId: 'fresco', session: 'cookrew:fresco', seq: 9, asked: 'group/opus-anywhere', group: 'group/opus-anywhere', model: 'copilot/claude-opus-5.5', effort: 'high', tries: 1, done: true, status: 'claude/opus at 98%', at: NOW - 470_000 }
        ]
      : [],
    harnesses: [
      { id: 'claude', name: 'Claude Code', installed: true, signedIn: true, inDock: true, installLine: 'npm i -g @anthropic-ai/claude-code', loginLine: 'claude' },
      { id: 'codex', name: 'Codex', installed: true, signedIn: online, inDock: true, installLine: 'npm i -g @openai/codex', loginLine: 'codex login' },
      { id: 'opencode', name: 'OpenCode', installed: false, signedIn: null, inDock: false, installLine: 'curl -fsSL https://opencode.ai/install | bash', loginLine: 'opencode auth login' },
      { id: 'pi', name: 'Pi', installed: true, signedIn: null, inDock: false, installLine: 'npm i -g @earendil-works/pi-coding-agent', loginLine: null }
    ],
    checkedAt: NOW,
    setup: SETUP_LINES
  }
}

export function cardRouteFixture(over: Partial<CardRouteState> = {}): CardRouteState {
  return {
    route: 'group/smart',
    effective: 'deepseek/deepseek-v4',
    appliesOn: 'now',
    live: { terminalId: 'forge', session: 'cookrew:forge', seq: 12, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-v4', effort: 'high', tries: 1, done: true, status: null, at: NOW - 48_000 },
    turn: { model: 'deepseek/deepseek-v4', inputTokens: 11_300, outputTokens: 1_100, cost: 0.018, at: NOW - 40_000 },
    offline: false,
    ...over
  }
}
