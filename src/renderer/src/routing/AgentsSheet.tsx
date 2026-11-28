import { useEffect, useState } from 'react'
import type { AgentPageRow } from '../../../shared/agents-page'
import type { HarnessRow } from '../../../shared/route'
import { cookrew } from '../api'
import './routing-panel.css'

/**
 * THE AGENTS PAGE — Magpie's Agents page, for Cookrew's harnesses (owner,
 * 2026-11-28). One row per harness the app can run: what it is (name, binary,
 * version), whether it is here and signed in, the line a new card of it
 * starts with, and what Cookrew adds on top. The actions that fix a row type
 * one line into the Setup card (the routing panel's own rule: no Cookrew form
 * for installing or signing in), and "Magpie" opens Magpie's page for the
 * agent, where its model and effort are kept.
 *
 * Read from main (main/agents-page.ts), which answers from the routing scan
 * and a version probe cached for ten minutes.
 */
export function AgentsSheet({
  onClose,
  onRun,
  onAddToDock,
  rowsOf
}: {
  onClose: () => void
  /** Type one line into the Setup card (use-setup-terminal). */
  onRun: (line: string) => void
  /** Put a harness in the dock's ＋ menu (the routing panel's own action). */
  onAddToDock?: (harness: HarnessRow) => void
  /** The scan's rows, for the dock action (which takes a harness row). */
  rowsOf: ReadonlyMap<string, HarnessRow>
}): React.JSX.Element {
  const [rows, setRows] = useState<AgentPageRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const read = async (): Promise<void> => {
      const page = cookrew().agentsPage
      if (!page) {
        setError('this desktop does not answer for agents yet — update it')
        return
      }
      try {
        const list = await page()
        if (live) setRows(list)
      } catch (next) {
        if (live) setError(next instanceof Error ? next.message : String(next))
      }
    }
    void read()
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openMagpie = async (row: AgentPageRow): Promise<void> => {
    const open = cookrew().agentOpenMagpie
    if (!open) return setSaid('this desktop cannot open Magpie yet')
    const answer = await open(row.id)
    setSaid(answer.ok ? `Opened Magpie · ${row.name}` : answer.error ?? 'Magpie did not open')
  }

  return (
    <div className="cr-routing cr-agents" role="dialog" aria-modal="true" aria-label="Agents" onClick={onClose}>
      <div className="cr-routing-panel cr-agents-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cr-routing-title">
          ▤ Agents
          <span className="sp" />
          <button type="button" className="cr-routing-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {error !== null && <div className="cr-routing-bad" role="alert">{error}</div>}
        {said !== null && <div className="cr-agents-said" role="status">{said}</div>}
        {rows === null && error === null && <div className="cr-routing-empty"><b>READING AGENTS…</b>one moment</div>}
        {rows?.map((row) => (
          <AgentRow key={row.id} row={row} onRun={onRun} onAddToDock={onAddToDock} rowsOf={rowsOf} onMagpie={openMagpie} />
        ))}
      </div>
    </div>
  )
}

/** One harness's row: its state, its launch line, and the actions that fix it. Exported for its own test. */
export function AgentRow({
  row,
  onRun,
  onAddToDock,
  rowsOf,
  onMagpie
}: {
  row: AgentPageRow
  onRun: (line: string) => void
  onAddToDock?: (harness: HarnessRow) => void
  rowsOf: ReadonlyMap<string, HarnessRow>
  onMagpie: (row: AgentPageRow) => Promise<void>
}): React.JSX.Element {
  const dockRow = rowsOf.get(row.id)
  return (
    <div className="cr-agents-row">
      <div className="cr-agents-head">
        <span className="cr-agents-name">{row.name}</span>
        <span className="cr-agents-bin">{row.bin}</span>
        {row.version !== null && <span className="cr-agents-ver">v{row.version}</span>}
        <span className="sp" />
        <span className={`cr-agents-chip ${row.installed ? 'on' : 'off'}`}>{row.installed ? 'INSTALLED' : 'MISSING'}</span>
        {row.installed && row.signedIn === true && <span className="cr-agents-chip on">SIGNED IN</span>}
        {row.installed && row.signedIn === false && <span className="cr-agents-chip off">NOT SIGNED IN</span>}
        {row.inDock && <span className="cr-agents-chip">IN DOCK</span>}
      </div>
      <div className="cr-agents-line">{row.command}</div>
      {row.note !== null && <div className="cr-agents-note">{row.note}</div>}
      <div className="cr-agents-actions">
        {!row.installed && row.installLine !== '' && (
          <button type="button" className="cr-routing-btn" onClick={() => onRun(row.installLine)}>
            Install
          </button>
        )}
        {row.installed && row.signedIn === false && row.loginLine !== null && (
          <button type="button" className="cr-routing-btn" onClick={() => onRun(row.loginLine as string)}>
            Sign in
          </button>
        )}
        {!row.inDock && onAddToDock !== undefined && dockRow !== undefined && (
          <button type="button" className="cr-routing-btn" onClick={() => onAddToDock(dockRow)}>
            Add to dock
          </button>
        )}
        {row.magpieAgent !== null && (
          <button type="button" className="cr-routing-btn" onClick={() => void onMagpie(row)} title="Open Magpie's page for this agent (its model and effort are kept there)">
            Magpie
          </button>
        )}
      </div>
    </div>
  )
}
