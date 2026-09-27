import { useEffect, useState } from 'react'
import type { LandResult, LaneInfo, TerminalNodeData } from '../../shared/model'
import { cookrew } from './api'

/**
 * THE LANE PANE — the card menu's LANE ▸ page.
 *
 * Two states. In the SHARED TREE: name a lane and OPEN it (the agent
 * respawns there, conversation carried). In a LANE: where it stands against
 * base (unlanded commits, commits behind, uncommitted edits, conflicts),
 * LAND, LAND & CLOSE, CLOSE, and the AUTO-LAND switch. Every landing answer
 * is shown here in the words lanes.ts chose; none of it ever goes into the
 * agent's conversation, which is the point.
 */
export function LanePane({ terminal, onDone }: { terminal: TerminalNodeData; onDone: () => void }): React.JSX.Element {
  const [lanes, setLanes] = useState<LaneInfo[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<LandResult | null>(null)
  const api = cookrew()

  const refresh = (): void => {
    void api
      .laneList(terminal.cwd)
      .then(setLanes)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(refresh, [terminal.cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = lanes?.find((l) => l.path === terminal.cwd) ?? null
  const inLane = mine !== null && !mine.isMain
  const sharedTree = lanes?.find((l) => l.isMain) ?? null

  const run = (op: () => Promise<unknown>, close = false): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void op()
      .then(() => (close ? onDone() : refresh()))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const land = (close: boolean): void => {
    run(() =>
      api.laneLand(terminal.id, { close }).then((result) => {
        setAnswer(result)
        if (result.ok && close) onDone()
      })
    )
  }

  if (lanes === null && !error) return <div className="cr-cardmenu-hint">Reading the repo…</div>
  if (lanes !== null && lanes.length === 0) {
    return <div className="cr-cardmenu-hint">Not a git repo — a lane needs one.</div>
  }

  return (
    <div className="cr-cardmenu-pane col">
      {!inLane && (
        <>
          <div className="cr-cardmenu-hint">
            In the shared tree{sharedTree?.branch ? ` on ${sharedTree.branch}` : ''}. A lane is a worktree of its own, on
            its own branch; this agent moves there and its work lands back by a press here, never by a prompt.
          </div>
          <input
            className="tf-input"
            placeholder="lane name"
            value={name}
            autoFocus
            aria-label="Lane name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) run(() => api.laneOpen(terminal.id, name.trim()), true)
              e.stopPropagation()
            }}
          />
          <button
            className="cr-btn sm"
            disabled={busy || !name.trim()}
            onClick={() => run(() => api.laneOpen(terminal.id, name.trim()), true)}
          >
            {busy ? '…' : 'OPEN LANE'}
          </button>
        </>
      )}
      {inLane && mine && (
        <>
          <div className="cr-lane-state">
            <span className="cr-lane-branch">{mine.branch ?? 'detached'}</span>
            <span className="cr-lane-arrow">→ {mine.base}</span>
            <span className={`cr-lane-fact${mine.ahead > 0 ? ' warn' : ''}`}>{mine.ahead} unlanded</span>
            {mine.behind > 0 && <span className="cr-lane-fact">{mine.behind} behind</span>}
            {mine.dirty && <span className="cr-lane-fact warn">uncommitted</span>}
            {mine.conflicts.length > 0 && <span className="cr-lane-fact bad">{mine.conflicts.length} in conflict</span>}
          </div>
          {mine.conflicts.length > 0 && (
            <div className="cr-cardmenu-hint">
              Resolve in the lane, commit, then LAND again: {mine.conflicts.join(', ')}
            </div>
          )}
          <div className="cr-lane-actions">
            <button className="cr-btn sm primary" disabled={busy || mine.ahead === 0} onClick={() => land(false)}>
              {busy ? '…' : 'LAND'}
            </button>
            <button className="cr-btn sm" disabled={busy || mine.ahead === 0} onClick={() => land(true)}>
              LAND &amp; CLOSE
            </button>
            <button
              className="cr-btn sm"
              disabled={busy}
              title={mine.ahead > 0 || mine.dirty ? 'Refused while work is unlanded — LAND first' : 'Remove the lane, back to the shared tree'}
              onClick={() => run(() => api.laneClose(terminal.id), true)}
            >
              CLOSE
            </button>
          </div>
          <label className="cr-check cr-lane-auto" title="Land whenever a turn ends with the lane committed and ahead">
            <input
              type="checkbox"
              checked={!!terminal.laneAutoLand}
              disabled={busy}
              onChange={(e) => run(() => api.laneAuto(terminal.id, e.target.checked))}
            />
            AUTO-LAND after each turn
          </label>
        </>
      )}
      {(answer ?? terminal.laneLast) && <LandAnswer answer={answer ?? terminal.laneLast!} />}
      {error && (
        <div className="cr-cardmenu-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/** A landing's answer, in the words lanes.ts chose. */
export function landWords(answer: LandResult): string {
  // The gate is named when the answer carries the field at all: a landing
  // that ran one says which, one that ran none says so, and an older answer
  // stored before the field existed says nothing about it.
  const gate = answer.gate === undefined ? '' : answer.gate === null ? ' · no gate' : ` · gate: ${answer.gate}`
  if (answer.ok) return `Landed ${answer.commits} commit${answer.commits === 1 ? '' : 's'} → ${answer.landed}${answer.closed ? ', lane closed' : ''}${gate}`
  switch (answer.reason) {
    case 'dirty':
      return `Uncommitted changes in the lane — the agent's part is to commit${answer.files?.length ? `: ${answer.files.join(', ')}` : ''}`
    case 'conflict':
      return `Conflict in the lane${answer.files?.length ? `: ${answer.files.join(', ')}` : ''} — resolve there, commit, LAND again`
    case 'main-dirty':
      return `The shared tree has uncommitted edits${answer.files?.length ? `: ${answer.files.join(', ')}` : ''} — nobody should edit there`
    case 'main-branch':
      return `The shared tree is not on the base branch${answer.detail ? ` (${answer.detail})` : ''}`
    case 'gate':
      return `The gate failed in the lane${answer.gate ? ` (${answer.gate})` : ''}${answer.detail ? `:\n${answer.detail}` : ''}`
    case 'nothing':
      return 'Nothing to land — the lane has no commits base does not'
    default:
      return answer.detail ?? 'Not a lane'
  }
}

function LandAnswer({ answer }: { answer: LandResult }): React.JSX.Element {
  return (
    <div className={`cr-lane-answer${answer.ok ? ' ok' : ' bad'}`} role="status">
      {landWords(answer)}
    </div>
  )
}
