import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitInfo, TeamClipStatus, TeamMeta, WorkspaceState } from '../../shared/model'
import { saveClash, selectionSummary } from '../../shared/team-actions'
import { cookrew, isDemoMode } from './api'
import { MKT_SERVE, fillCopy } from '../../shared/marketplace-copy'
import {
  EMPTY_SERVED_PAYMENT_STATUS,
  readyPaymentRails,
  type ServedPaymentStatus
} from '../../shared/served-payment-config'
import {
  ShareOnSave,
  canSubmitShare,
  saveButtonLabel,
  serveRefusalText,
  type ShareAccess
} from './ShareOnSave'
import { TeamGraphThumb } from './TeamGraphThumb'
import { PaymentSettingsSheet } from './PaymentSettingsSheet'
import { ServedTeamCard, type ServedTeam } from './ServedTeamCard'

/** gitInfo is bridge-only today; feature-detect like GitChip does. */
type GitApi = { gitInfo?: (dir: string) => Promise<GitInfo | null> }

/** Finger or mouse — the empty-selection hint should say the right verb. */
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches

/**
 * The clipboard toggle's action bar: the picked cards (checkboxes, cables
 * included) are a clipboard selection, exactly the OS idiom —
 *
 *   COPY  (⌘C)  stage the selection; PASTE it here or in any workspace.
 *   CUT   (⌘X)  same, but a successful paste removes the originals — the
 *               way a team clips from one workspace to another.
 *   SAVE  (⌘S)  snapshot the selection as a reusable template.
 *   PASTE (⌘V)  drop the staged selection onto THIS canvas; agents adopt
 *               this workspace's workdir via the recover-style session
 *               restore. The clipboard lives in the main process, so it
 *               survives switching workspaces between copy and paste.
 *
 * Every action is a pressable button too — phones have no ⌘. The bar is
 * present the whole time the clipboard toggle is on: PASTE must be
 * reachable before anything is picked. Working agents can't be copied;
 * their checkboxes are disabled and the backend refuses them by name.
 *
 * Saving over an existing template destroys it, so a clashing name demands
 * a second, explicit press — see saveClash.
 */
export function SelectionBar({
  workspace,
  picked,
  onClipChange,
  onPasted
}: {
  workspace: WorkspaceState
  picked: ReadonlySet<string>
  /** Lifts the clipboard status to App — the cross-workspace paste ghosts. */
  onClipChange: (clip: TeamClipStatus | null) => void
  /** A successful paste exits copy-paste mode back to the MOVE hand. */
  onPasted: () => void
}): React.JSX.Element | null {
  const [clip, setClip] = useState<TeamClipStatus | null>(null)
  const [naming, setNaming] = useState(false)
  // SHARE ON SAVE (owner ruling 2026-08-26): the share question lives where the
  // team is NAMED — this is THE publish entry, not a parallel admin panel.
  const [access, setAccess] = useState<ShareAccess>('just-me')
  const [priceUsd, setPriceUsd] = useState('')
  const [paymentStatus, setPaymentStatus] = useState<ServedPaymentStatus>(
    EMPTY_SERVED_PAYMENT_STATUS
  )
  const [paymentSettingsOpen, setPaymentSettingsOpen] = useState(false)
  const paymentRails = readyPaymentRails(paymentStatus)
  const [servedTeams, setServedTeams] = useState<readonly ServedTeam[]>([])
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({})
  const [openServedTeam, setOpenServedTeam] = useState<ServedTeam | null>(null)
  /** THE PAYOFF of a serving save: the address, held on screen until DONE.
   *  A 3-second flash was the original sin here — the user saved a paid team
   *  and never saw the link they were supposed to hand out. */
  const [servedAt, setServedAt] = useState<string | null>(null)
  const [servedName, setServedName] = useState('')
  const [copied, setCopied] = useState(false)
  const [name, setName] = useState('')
  const [teams, setTeams] = useState<TeamMeta[]>([])
  /** The overwrite guard is only trustworthy once the list has ARRIVED —
   *  autofocus + Enter can beat the fetch, and an unknown list must block
   *  the save, not wave it through. */
  const [teamsLoaded, setTeamsLoaded] = useState(false)
  /** A clashing SAVE was pressed once; the next press overwrites. */
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState<'copy' | 'cut' | 'paste' | 'save' | null>(null)
  /** Shared git-repo workdir of every picked agent, or null — gates the
   *  WORKTREE option (isolation on paste, previous-question follow-up). */
  const [repoDir, setRepoDir] = useState<string | null>(null)
  const [wtOn, setWtOn] = useState(false)
  const [wtName, setWtName] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  const errorTimer = useRef<number | undefined>(undefined)
  /** Leaving SELECT mode unmounts the bar mid-action; late resolutions must
   *  neither set state nor schedule timers into a dead component. Re-armed
   *  in the effect BODY — StrictMode's mount/cleanup/mount would otherwise
   *  leave it false forever and every action would hang. */
  const alive = useRef(true)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Latest handlers for the document-level listeners. */
  const dismissRef = useRef<() => void>(() => undefined)
  const hotkeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  const onClipChangeRef = useRef(onClipChange)
  const onPastedRef = useRef(onPasted)
  useEffect(() => {
    onClipChangeRef.current = onClipChange
    onPastedRef.current = onPasted
  })

  const refreshServing = useCallback((): void => {
    void cookrew().servingPaymentStatus().then(setPaymentStatus).catch(() => undefined)
    void cookrew().servingList().then(setServedTeams).catch(() => undefined)
    void cookrew()
      .servingSessions()
      .then((sessions) => {
        const counts: Record<string, number> = {}
        for (const session of sessions) {
          counts[session.serviceId] = (counts[session.serviceId] ?? 0) + 1
        }
        setSessionCounts(counts)
      })
      .catch(() => undefined)
  }, [])
  useEffect(refreshServing, [refreshServing])

  /** Every clip update ALSO lifts to App (paste ghosts live up there). */
  const updateClip = (status: TeamClipStatus | null): void => {
    setClip(status)
    onClipChangeRef.current(status)
  }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      window.clearTimeout(flashTimer.current)
      window.clearTimeout(errorTimer.current)
    }
  }, [])

  // The clipboard lives in MAIN and outlives this component — ask what it
  // holds on mount and again after every workspace SWITCH (the whole point
  // is pasting after one). Keyed on the active workspace ID via the list
  // subscription; the state object itself has no id and names can collide.
  useEffect(() => {
    const refetch = (): void => {
      void cookrew()
        .teamClipGet?.()
        .then((status) => {
          if (alive.current) updateClip(status)
        })
        .catch(() => undefined)
    }
    refetch()
    let lastActiveId: string | null = null
    return cookrew().onWorkspaceList((list) => {
      if (lastActiveId !== null && list.activeId !== lastActiveId) refetch()
      lastActiveId = list.activeId
    })
  }, [])

  // Fresh template list each time the name field opens — the overwrite
  // guard is only as good as its knowledge of what already exists.
  useEffect(() => {
    if (!naming) return
    setTeamsLoaded(false)
    void cookrew()
      .teamList()
      .then((l) => {
        if (!alive.current) return
        setTeams(l)
        setTeamsLoaded(true)
      })
      .catch(() => undefined)
  }, [naming])

  // Clicking/tapping away (or Escape) cancels the name field. onBlur alone
  // misses this (the canvas pane suppresses the focus change), a
  // bubble-phase document listener misses it too (d3-zoom stops propagation
  // on the pane), and mousedown never fires on touch when d3-zoom
  // preventDefaults touchstart — so: pointerdown, capture phase.
  useEffect(() => {
    if (!naming) return
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) dismissRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        dismissRef.current()
      }
    }
    document.addEventListener('pointerdown', onDown, { capture: true })
    document.addEventListener('keydown', onKey, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true })
      document.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [naming])

  // The WORKTREE option appears only when every picked agent shares ONE
  // workdir and that dir is a git repo — verified live, not assumed.
  useEffect(() => {
    const cwds = new Set(
      workspace.nodes
        .filter((n) => n.kind === 'terminal' && picked.has(n.id))
        .map((n) => (n as { cwd: string }).cwd)
    )
    const shared = cwds.size === 1 ? [...cwds][0] : null
    const gitInfo = (cookrew() as unknown as GitApi).gitInfo
    if (shared === null || !gitInfo) {
      setRepoDir(null)
      return
    }
    let stale = false
    void gitInfo(shared)
      .then((info) => {
        if (!stale && alive.current) setRepoDir(info?.isRepo ? shared : null)
      })
      .catch(() => {
        if (!stale && alive.current) setRepoDir(null)
      })
    return () => {
      stale = true
    }
  }, [picked, workspace])
  // The checkbox can't stay armed once the option disappears.
  useEffect(() => {
    if (repoDir === null) setWtOn(false)
  }, [repoDir])

  // ⌘C/⌘X/⌘V/⌘S while the bar is up — never while typing (a terminal's own
  // ⌘C must keep copying text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => hotkeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const summary = selectionSummary(workspace, [...picked])
  const clash = naming ? saveClash(teams, name, workspace.name) : null
  /**
   * The one door a caller reaches: the orch among the PICKED cards, or null.
   *
   * No fallback. This used to answer first-picked-terminal, else the word
   * 'Conductor' — so a selection with no orch showed a confident "Callers talk
   * to Shell (2) only", saved, served, and handed the first stranger's prompt
   * to a zsh prompt. The backend's matching fallback is gone too; both sides
   * now agree that no orch means no door (owner ruling, 2026-08-26).
   */
  const orchName =
    workspace.nodes.find(
      (n) => picked.has(n.id) && n.kind === 'terminal' && (n as { orch?: boolean }).orch
    )?.name ?? null
  const canClip = cookrew().teamClipSet !== undefined

  const showFlash = (text: string): void => {
    if (!alive.current) return
    setFlash(text)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 3200)
  }

  const fail = (err: unknown): void => {
    if (!alive.current) return
    setBusy(null)
    setError(err instanceof Error ? err.message : String(err))
    // Errors fade like flashes do — a permanent red pin would also mute
    // every later success (flash renders only when !error).
    window.clearTimeout(errorTimer.current)
    errorTimer.current = window.setTimeout(() => setError(null), 8000)
  }

  const refreshClip = (): void => {
    void cookrew()
      .teamClipGet?.()
      .then((status) => {
        if (alive.current) updateClip(status)
      })
      .catch(() => undefined)
  }

  const wtStaged = wtOn && repoDir !== null
  /** Worktree checked but unnamed — COPY/CUT wait for the name. */
  const wtBlocking = wtStaged && wtName.trim() === ''

  const runClip = (cut: boolean): void => {
    if (busy || picked.size === 0 || wtBlocking) return
    const set = cookrew().teamClipSet
    if (!set) return
    // A shell has no session to restore — its copy just re-runs the command
    // in a fresh shell. Worth a word when a running program might be lost.
    const hasShells = workspace.nodes.some(
      (n) =>
        picked.has(n.id) &&
        n.kind === 'terminal' &&
        (n as { command: string }).command.trim() === ''
    )
    setBusy(cut ? 'cut' : 'copy')
    setError(null)
    void set([...picked], cut, wtStaged ? { name: wtName.trim() } : undefined)
      .then((status) => {
        if (!alive.current) return
        setBusy(null)
        updateClip(status)
        const wt = status.worktreeName ? ` → worktree “${status.worktreeName}”` : ''
        const shells = hasShells ? ' · shells restart fresh' : ''
        showFlash(
          cut
            ? `cut ${status.count}${wt} — paste to move them${shells}`
            : `copied ${status.count}${wt} — paste here or in another workspace${shells}`
        )
      })
      .catch(fail)
  }

  const runPaste = (): void => {
    if (busy || !clip) return
    const paste = cookrew().teamPaste
    if (!paste) return
    setBusy('paste')
    setError(null)
    void paste()
      .then(() => {
        if (!alive.current) return
        setBusy(null)
        // The pasted cards appearing (plus the team event toast, which
        // carries any context-staleness note) ARE the feedback — the mode
        // exits so the user lands back on the MOVE hand with the result.
        void cookrew()
          .teamClipGet?.()
          .then((s) => onClipChangeRef.current(s ?? null))
          .catch(() => undefined)
        onPastedRef.current()
      })
      .catch((err: unknown) => {
        fail(err)
        refreshClip()
      })
  }

  const runSave = (): void => {
    if (busy) return
    if (!naming) {
      if (picked.size > 0) setNaming(true)
      return
    }
    // Autofocus + Enter can beat the teamList fetch; an unknown list must
    // block (the guard would otherwise wave through a silent overwrite).
    if (!teamsLoaded) return
    // The same refusal the disabled button carries. Enter in the name field
    // reaches here without touching the button, and a save that published an
    // orch-less crew by keyboard would be the bug with an extra step.
    if (!canSubmitShare(access, priceUsd, orchName, paymentRails)) return
    if (clash && !armed) {
      setArmed(true)
      return
    }
    setBusy('save')
    setError(null)
    void cookrew()
      .teamSave(name.trim() || undefined, [...picked])
      .then(async (meta) => {
        if (!alive.current) return
        // Saving names the thing; the same breath decides who may call it.
        if (access !== 'just-me') {
          const served = await cookrew().servingServe({
            templateId: meta.name,
            access,
            ...(access === 'paid' ? { priceUsd: priceUsd.trim() } : {})
          })
          if (!alive.current) return
          if (served?.ok) {
            setServedAt(served.address)
            setServedName(meta.name)
            setCopied(false)
            refreshServing()
          } else {
            // In words. The sheet already refuses every reason it can see, so a
            // refusal that still arrives is one it could not — a template that
            // vanished, or an orch removed between the sheet and the save — and
            // a bare `no-orch` on the bar teaches the owner nothing.
            setError(`Saved, but couldn't start serving — ${serveRefusalText(served?.reason)}`)
          }
        }
        setBusy(null)
        setNaming(false)
        setName('')
        setArmed(false)
        // A private save flashes; a serving save gets the ADDRESS CARD instead —
        // the address is the deliverable, and it must outlive a 3-second flash.
        if (access === 'just-me') showFlash(`saved template “${meta.name}”`)
        // The save cut a version pin on each saved agent (main process). Tell
        // any open rail to re-fetch so the marker appears NOW, not on the next
        // turn — otherwise a save reads as if it did nothing.
        window.dispatchEvent(new CustomEvent('cookrew:template-saved'))
      })
      .catch(fail)
  }

  const dismissTransients = (): void => {
    if (busy === 'save') return
    setNaming(false)
    setName('')
    setArmed(false)
  }

  // Assigned in effects-adjacent refs, not consumed during render — and
  // every hook sits ABOVE the demo-mode return so the hook order never
  // varies.
  useEffect(() => {
    dismissRef.current = dismissTransients
    hotkeyRef.current = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      const typing = target?.closest('input, textarea, [contenteditable="true"], .xterm') ?? null
      // Typing in the bar's OWN name field keeps ⌘S alive (confirm the
      // save); typing anywhere else owns all its shortcuts.
      const inBar = typing !== null && (rootRef.current?.contains(typing) ?? false)
      if (typing && !inBar) return
      const key = e.key.toLowerCase()
      // preventDefault ONLY when the action actually runs — a no-op must
      // not hijack native copy/paste (selecting text in a note, xterm).
      const handled = inBar
        ? key === 's' && (runSave(), true)
        : key === 'c'
          ? picked.size > 0 && !busy && (runClip(false), true)
          : key === 'x'
            ? picked.size > 0 && !busy && (runClip(true), true)
            : key === 'v'
              ? clip !== null && !busy && (runPaste(), true)
              : key === 's'
                ? (picked.size > 0 || naming) && !busy && (runSave(), true)
                : false
      if (handled) e.preventDefault()
    }
  })

  // The demo API rejects every team call; no bar beats a bar of dead ends.
  if (isDemoMode()) return null

  return (
    <div className="cr-selbar" ref={rootRef}>
      {/* THE ADDRESS CARD — a serving save's receipt. It stays until DONE:
          the whole point of a serving save is handing this link to someone,
          and a surface that closed itself is exactly the bug being fixed. */}
      {servedAt && !naming && (
        <div className="cr-selbar-share cr-selbar-served" role="status" aria-live="polite">
          <span className="sos-live-t">
            {fillCopy(MKT_SERVE['mkt.serve.live'], { templateName: servedName })}
          </span>
          <div className="sos-live">
            <code className="sos-addr">{servedAt}</code>
            <button
              className="cr-btn sm"
              onClick={() => {
                void navigator.clipboard?.writeText(servedAt)
                setCopied(true)
              }}
            >
              {copied ? 'COPIED ✓' : 'COPY LINK'}
            </button>
          </div>
          <p className="sos-note">{MKT_SERVE['mkt.serve.live.handoff']}</p>
          <div className="cr-selbar-served-acts">
            <button className="cr-btn sm" onClick={() => setServedAt(null)}>
              DONE
            </button>
          </div>
        </div>
      )}
      {/* What the clipboard holds, as ONE picture — the element chips laid
          out by their real relative positions with the cables drawn between
          them. ✂ marks stateful identity moves (a cut browser carries its
          cookies/session whole; copies are deliberately stateless). */}
      {clip && !naming && (
        <div className="cr-selbar-tray" role="status" aria-label="Clipboard contents">
          <TeamGraphThumb
            graph={{ items: clip.items, cables: clip.cables }}
            width={Math.min(240, 70 + clip.items.length * 24)}
            height={clip.items.length === 1 ? 36 : 64}
            movedIds={new Set(clip.items.filter((i) => i.moves).map((i) => i.id))}
          />
          <span className="cr-selbar-tray-from">FROM {clip.fromWorkspaceName.toUpperCase()}</span>
        </div>
      )}
      {/* The in-flow controls, boxed as their own row: narrow screens put the
          sideways scroll HERE. The bar itself must never scroll — it is the
          containing block of the popovers floated above it, and overflow on
          it clips them all (how the share sheet vanished on phones). The
          popovers also stay OUT of this row, belt and braces: the row cannot
          clip them while it is unpositioned, but one future position/
          transform on the scroll strip would recapture them. */}
      <div className="cr-selbar-row">
        {/* Ongoing serve management lives with SAVE, never inside FORK TEAM. */}
        {servedTeams.length > 0 && !naming && (
          <div className="cr-selbar-serving" aria-label="Teams taking calls">
            <span className="sos-live-t">TAKING CALLS</span>
            {servedTeams.map((team) => (
              <button
                key={team.serviceId}
                className="cr-chip clickable cr-serving-badge"
                title={`Manage ${team.templateId}`}
                onClick={() => setOpenServedTeam(team)}
              >
                {team.templateId} · {sessionCounts[team.serviceId] ?? 0}
              </button>
            ))}
          </div>
        )}
        <span className="cr-selbar-count">
          {picked.size === 0
            ? COARSE_POINTER
              ? 'TAP CARDS TO SELECT'
              : 'CLICK CARDS TO SELECT · ⌘A FOR ALL'
            : `${summary.nodes} SELECTED${summary.cables > 0 ? ` · ${summary.cables} CABLE${summary.cables === 1 ? '' : 'S'}` : ''}`}
        </span>

        {error && (
          <span className="cr-selbar-error" role="status" aria-live="assertive" title={error}>
            {error}
          </span>
        )}
        {flash && !error && (
          <span className="cr-selbar-flash" role="status" aria-live="polite">
            {flash} ✓
          </span>
        )}

        {naming ? (
          <>
            {armed && clash && !error && (
              <span className="cr-selbar-warn" role="status" aria-live="assertive">
                replaces “{clash.name}”
              </span>
            )}
            <input
              className="cr-selbar-name"
              aria-label="Template name"
              placeholder={workspace.name}
              value={name}
              autoFocus
              disabled={busy === 'save'}
              onChange={(e) => {
                setName(e.target.value)
                setArmed(false)
              }}
              onKeyDown={(e) => {
                // Typing must never reach canvas hotkeys, and Escape must not
                // also deselect or zoom-back.
                e.stopPropagation()
                if (e.key === 'Enter') runSave()
                if (e.key === 'Escape') dismissTransients()
              }}
            />
            <button
              className="cr-btn sm"
              disabled={
                busy !== null ||
                !teamsLoaded ||
                !canSubmitShare(access, priceUsd, orchName, paymentRails)
              }
              onClick={runSave}
            >
              {armed && clash ? 'SAVE AGAIN?' : saveButtonLabel(access, busy === 'save')}
            </button>
          </>
        ) : (
          <>
            {canClip && repoDir !== null && (
              <label
                className="cr-check cr-selbar-wt"
                title={`Paste spawns the copies in a FRESH git worktree of ${repoDir} — isolated branch, no stepping on the originals`}
              >
                <input
                  type="checkbox"
                  checked={wtOn}
                  onChange={(e) => setWtOn(e.target.checked)}
                />
                WORKTREE
              </label>
            )}
            {canClip && wtStaged && (
              <input
                className="cr-selbar-name"
                aria-label="Fresh worktree name"
                placeholder="fresh worktree name"
                value={wtName}
                autoFocus
                onChange={(e) => setWtName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
            {canClip && (
              <button
                className="cr-btn sm"
                title={
                  wtBlocking
                    ? 'Name the worktree first'
                    : 'Copy the selection to the clipboard (⌘C) — paste in any workspace'
                }
                disabled={busy !== null || picked.size === 0 || wtBlocking}
                onClick={() => runClip(false)}
              >
                {busy === 'copy' ? 'COPYING…' : 'COPY'}
              </button>
            )}
            {canClip && (
              <button
                className="cr-btn sm"
                title={
                  wtBlocking
                    ? 'Name the worktree first'
                    : 'Cut the selection (⌘X) — pasting moves it out of this workspace'
                }
                disabled={busy !== null || picked.size === 0 || wtBlocking}
                onClick={() => runClip(true)}
              >
                {busy === 'cut' ? 'CUTTING…' : 'CUT'}
              </button>
            )}
            <button
              className="cr-btn sm"
              title="Save the selection as a reusable team template (⌘S) — cables included"
              disabled={busy !== null || picked.size === 0}
              onClick={runSave}
            >
              SAVE
            </button>
            {/* PASTE exists only once something is staged — an unpressable
                button teaches nothing; the empty state teaches copy/cut. */}
            {canClip && clip && (
              <button
                className="cr-btn sm primary"
                title={
                  `Paste ${clip.count} from “${clip.fromWorkspaceName}” here (⌘V)` +
                  `${clip.worktreeName ? ` into worktree “${clip.worktreeName}”` : ''}` +
                  `${clip.cut ? ' — moves them' : ''}`
                }
                disabled={busy !== null}
                onClick={runPaste}
              >
                {busy === 'paste' ? 'PASTING…' : `PASTE ${clip.count}${clip.cut ? ' ✂' : ''}`}
              </button>
            )}
          </>
        )}
      </div>
      {/* The share question, in the same breath as the name — floated above
          the bar as a popover, so it sits OUTSIDE the scrollable row. */}
      {naming && (
        <div className="cr-selbar-share">
          <ShareOnSave
            access={access}
            priceUsd={priceUsd}
            paymentRails={paymentRails}
            door={orchName}
            onAccess={setAccess}
            onPrice={setPriceUsd}
            onConfigurePayments={() => setPaymentSettingsOpen(true)}
          />
        </div>
      )}
      {paymentSettingsOpen && (
        <PaymentSettingsSheet
          status={paymentStatus}
          onStatus={(next) => {
            setPaymentStatus(next)
            refreshServing()
          }}
          onClose={() => setPaymentSettingsOpen(false)}
        />
      )}
      {openServedTeam && (
        <ServedTeamCard
          team={openServedTeam}
          door={orchName}
          paymentStatus={paymentStatus}
          onConfigurePayments={() => setPaymentSettingsOpen(true)}
          onStopped={() => {
            setOpenServedTeam(null)
            refreshServing()
          }}
          onClose={() => setOpenServedTeam(null)}
        />
      )}
    </div>
  )
}
