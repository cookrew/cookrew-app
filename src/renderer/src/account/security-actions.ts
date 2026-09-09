import type { AccountResult, AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { DOING, problemSentence, refusedSentence } from './problem'

/**
 * The three things the security card DOES, wired once.
 *
 * The card appears twice — once right after claiming and again in the profile
 * sheet's SECURITY tab — and both need the same three calls. Written twice they
 * are two chances for the lock delay to persist in one place and not the other,
 * which is the sort of drift a person only finds after their Mac failed to
 * lock. So it is a factory, not a copied block.
 *
 * Every call is best-effort: a refusal leaves the status as it was rather than
 * throwing into a render, and the card's own error line covers what a person
 * can act on.
 */
export function securityActions(
  onStatus: (next: AccountStatus) => void,
  after?: () => void,
  /**
   * Where a failure is SAID. These three write to the disk, so they can fail
   * for a reason the owner can act on — and a swallowed `.catch` was how a
   * lock delay could refuse to stick with the card still showing the value
   * that had not been saved.
   */
  onProblem: (sentence: string) => void = () => undefined,
): {
  onLockAfterMs: (ms: number) => void
  onLockNow: () => void
  onCodesSaved: () => void
} {
  const settle = (result: AccountResult<AccountStatus>): void => {
    if (result.ok) onStatus(result.value)
    else onProblem(refusedSentence(DOING.LOCK, result))
  }
  return {
    onLockAfterMs: (ms) => {
      void cookrew()
        .accountSetLock?.(ms)
        .then(settle)
        .catch((err: unknown) => onProblem(problemSentence(DOING.LOCK, err)))
    },
    /**
     * LOCK NOW. `after` closes the sheet the button was pressed in: the lock
     * covers it either way, but leaving a dialog open underneath means the
     * unlock drops you back into a settings screen you had finished with.
     */
    onLockNow: () => {
      after?.()
      void cookrew()
        .accountLock?.()
        .then(settle)
        .catch((err: unknown) => onProblem(problemSentence(DOING.LOCK, err)))
    },
    onCodesSaved: () => {
      void cookrew()
        .accountCodesSaved?.()
        .then((result) => {
          if (result.ok) onStatus(result.value)
          else onProblem(refusedSentence(DOING.SAVE_CODES, result))
        })
        .catch((err: unknown) => onProblem(problemSentence(DOING.SAVE_CODES, err)))
    },
  }
}
