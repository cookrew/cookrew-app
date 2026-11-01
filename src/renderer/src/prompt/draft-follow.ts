import { activityStore } from '../activity-thumb-store'
import { observeLine } from './live-line'
import { draftedAgents, subscribeDrafts } from './prompt-draft'

/**
 * A DRAFT FOLLOWS ITS LINE WITH NO BOX ON SCREEN (owner, 2026-11-01: the
 * crew shows an agent's unsent words under its face). A box keeps its own
 * agent's draft in step (live-line.ts · useLiveLine), but the crew's faces
 * carry none: words sent or cleared in LIVE, on the phone, or by the CLI
 * would stay under the face. So, outside React, each agent holding a draft
 * is watched for its line's readings, and only while it holds one; the faces
 * themselves still never re-render on an activity push.
 */
export function followDrafts(): () => void {
  const watching = new Map<string, () => void>()
  const sync = (): void => {
    const drafted = new Set(draftedAgents())
    for (const [id, stop] of [...watching]) {
      if (drafted.has(id)) continue
      stop()
      watching.delete(id)
    }
    for (const id of drafted) {
      if (watching.has(id)) continue
      watching.set(id, activityStore.subscribeKey(id, () => observeLine(id, activityStore.get(id))))
    }
  }
  sync()
  const stopDrafts = subscribeDrafts(sync)
  return () => {
    stopDrafts()
    for (const stop of watching.values()) stop()
    watching.clear()
  }
}
