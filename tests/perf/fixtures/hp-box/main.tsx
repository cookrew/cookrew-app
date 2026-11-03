import { createRoot } from 'react-dom/client'
import { CommandBox } from '../../../../src/renderer/src/CommandBox'
import type { Decision } from '../../../../src/main/sous-control'
import type { InboxRow } from '../../../../src/shared/inbox-rank'
import '../../../../src/renderer/src/styles.css'

/**
 * THE ONE BOX, ON ITS OWN, FOR THE STILLS — the HP scenes (lane hp-box):
 * `?scene=ticking|paused-exposure|question|answer|inbox-sous`. The box is the
 * real component on the demo api; the scene is a decision or a set of rows
 * handed through its test seams. Nothing here touches the owner's app.
 */
const sentence = 'Make the install section of README English'
const base: Decision = {
  kind: 'ask',
  target: { id: 'forge', name: 'Forge' },
  alternates: [
    { kind: 'ask', id: 'tinker', name: 'Tinker', reasons: ['idle', 'same repo', 'role: Bugfix'] },
    { kind: 'recruit', id: 'harness:Claude Code', name: 'Claude Code', harness: 'Claude Code', reasons: ['a brief with no shape → Claude Code'] }
  ],
  reasons: ['idle', 'same repo', 'last touched README · 2h'],
  recruit: { harness: 'Claude Code', name: 'Install Section', beside: null, direct: true },
  token: 'still',
  holdMs: 2500,
  sentence,
  route: { route: 'group/smart', effective: 'deepseek/deepseek-v4' }
}
const scenes: Record<string, { decision?: Decision; said?: string; rows?: InboxRow[]; text?: string }> = {
  ticking: { decision: { ...base, mode: 'ticking', exposure: 1 } },
  'paused-exposure': {
    decision: { ...base, kind: 'recruit', harness: 'Codex', name: 'Audit Every README', beside: { id: 'orch', name: 'Orch' }, direct: false, mode: 'paused', exposure: 2, exposureWhy: 'pushes to origin', boundaries: 'push only after the check passes', route: { route: 'group/smart', effective: null } } as Decision
  },
  question: { decision: { kind: 'question', question: 'Which repo — cookrew-dev or the site?', reasons: ['two repos match'], token: 'q', holdMs: 2500, sentence: 'fix the README', mode: 'question' } },
  answer: { decision: { ...base, mode: 'answer', alternates: [], reasons: ['Forge, Tinker and Magpie are idle in this repo; Forge last touched README.'] } },
  'inbox-sous': {
    rows: [
      { nodeId: 'bench-2', nodeName: 'Bench 2', nodeKind: 'terminal', workspaceId: 'ws', workspaceName: 'Cookrew Dev', kind: 'sous', kinds: ['sous'], reasons: ['the brief never reached the card'], since: Date.now() - 3 * 60_000, waitMinutes: 3, served: false, blockedDownstream: 0, score: 2, id: 'sous-1', action: 'retry', dismissable: true, text: 'Audit every README for stale install lines' },
      { nodeId: 'orch', nodeName: 'Sous', nodeKind: 'terminal', workspaceId: 'ws', workspaceName: 'Cookrew Dev', kind: 'sous', kinds: ['sous'], reasons: ['an answer'], since: Date.now() - 60_000, waitMinutes: 1, served: false, blockedDownstream: 0, score: 1, id: 'sous-2', action: null, dismissable: true, text: 'Three cards are idle in this repo; Forge last touched README.' },
      { nodeId: 'forge', nodeName: 'Forge', nodeKind: 'terminal', workspaceId: 'ws', workspaceName: 'Cookrew Dev', kind: 'waiting', kinds: ['waiting'], reasons: ['asks you — "replace the Chinese headings too?"'], since: Date.now() - 4 * 60_000, waitMinutes: 4, served: false, blockedDownstream: 2, score: 3 }
    ],
    text: 'rename Forge to Anvil'
  }
}
const scene = scenes[new URLSearchParams(location.search).get('scene') ?? 'ticking'] ?? scenes.ticking
document.body.style.background = '#f4efe4'
document.body.style.minHeight = '100vh'
createRoot(document.getElementById('root')!).render(
  <CommandBox open onClose={() => undefined} phone={false} rows={scene.rows ?? []} initialDecision={scene.decision ?? null} initialSaid={scene.said ?? null} initialText={scene.text ?? ''} />
)
