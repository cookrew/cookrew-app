import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { ACCOUNT_COPY } from '../../../shared/account-guide-copy'
import { guideVisible, type AccountVia } from '../../../shared/ai-account'
import type { FirstRunStage } from '../../../shared/first-run'

/**
 * THE LAUNCH NUDGE: past the first run, a launch that finds no AI account at all
 * says so once, with the way to the guide (the Routing panel's account section).
 * It waits a few seconds first: Claude's Keychain sign-in is read after the first
 * route state, and a nudge for an account that is there would be a false alarm.
 * "Not now" holds for this launch only; the next launch asks again while nothing
 * is connected, as the owner ruled (2026-11-16).
 */

export const SETTLE_MS = 6_000
/** After the fresh read is asked for, how long its answer has to land. */
export const ANSWER_MS = 1_500

/** Once per launch, across remounts of the shell. */
let dismissedThisLaunch = false

/** Whether the person's own endpoint is on; read again whenever `again` changes. */
export function useEndpointActive(again: unknown): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let live = true
    void cookrew()
      .accessState?.()
      .then((state) => live && setActive(state.active !== null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [again])
  return active
}

export function AccountNudgeView({ onOpen, onLater }: { onOpen: () => void; onLater: () => void }): React.JSX.Element {
  return (
    <div className="fr-nudge" role="status">
      <span>{ACCOUNT_COPY.NUDGE}</span>
      <button type="button" className="fr-go" onClick={onOpen}>
        {ACCOUNT_COPY.NUDGE_GO}
      </button>
      <button type="button" className="fr-quiet" onClick={onLater}>
        {ACCOUNT_COPY.NUDGE_LATER}
      </button>
    </div>
  )
}

export function AccountNudge({
  stage,
  via,
  known,
  onOpen,
  recheck
}: {
  stage: FirstRunStage
  via: AccountVia | null
  known: boolean
  onOpen: () => void
  /** Ask main again before deciding: the Keychain's answer lands after the first read. */
  recheck?: () => void
}): React.JSX.Element | null {
  const [settled, setSettled] = useState(false)
  const [dismissed, setDismissed] = useState(dismissedThisLaunch)
  useEffect(() => {
    if (!known) return
    const ask = setTimeout(() => recheck?.(), SETTLE_MS)
    const decide = setTimeout(() => setSettled(true), SETTLE_MS + ANSWER_MS)
    return () => {
      clearTimeout(ask)
      clearTimeout(decide)
    }
  }, [known, recheck])
  if (!guideVisible({ stage, via, settled, dismissed })) return null
  return (
    <AccountNudgeView
      onOpen={onOpen}
      onLater={() => {
        dismissedThisLaunch = true
        setDismissed(true)
      }}
    />
  )
}
