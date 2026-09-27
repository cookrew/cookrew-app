import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TeamMeta, WorkspaceList, WorkspaceMeta, WorkspaceState } from '../../shared/model'
import { workspaceMap } from '../../shared/workspace-map'
import { cookrew } from './api'
import { DirectoryManager } from './DirectoryManager'
import { WorkspaceWall } from './WorkspaceWall'
import { planRemove } from './workspace-wall-actions'
import type { Snapshot } from './workspace-wall-store'
import { hasNativeDirPicker, pickDirectory, removeWorkspace } from './workspace-v2'

/**
 * THE WALL'S HOST — everything the wall needs from the app, in one hook.
 *
 * The wall itself draws and decides nothing; this is where its list, its
 * pictures, its recency order and the four things it can do to a workspace
 * (enter, make, give directories, remove) meet the bridge. It lived inline in
 * App.tsx while the wall was only a switcher; now that it is the whole
 * workspace surface it has enough of its own to be a file.
 *
 * The list and the recency order are held here because the wall is opened
 * from the header and covers the stage; the snapshots are fetched only when
 * it opens, never held, because they are a few hundred kilobytes of base64
 * each and are looked at for two seconds.
 */
export function useWorkspaceWall(opts: {
  /** The canvas area the wall covers and hands back to. */
  stageRef: RefObject<HTMLDivElement | null>
  /**
   * The live workspace, for the one screen no camera can reach. `snapWorkspace`
   * is Electron's; the phone answers false to it and may not fire a capture on
   * the Mac, so the screen for the canvas the reader is STANDING IN read NO
   * SNAPSHOT YET. Its shape comes from this instead (workspace-map.ts).
   */
  workspace: WorkspaceState | null
  /** The activity / history panel — a property of the live workspace. */
  onActivity: () => void
}): { open: () => void; element: React.JSX.Element } {
  const { stageRef, workspace, onActivity } = opts
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [shots, setShots] = useState<Record<string, Snapshot>>({})
  const [teams, setTeams] = useState<TeamMeta[]>([])
  const [stage, setStage] = useState<DOMRect | null>(null)
  const [dirs, setDirs] = useState<WorkspaceMeta | null>(null)
  const recentRef = useRef<string[]>([])
  const openRef = useRef(false)
  useEffect(() => {
    openRef.current = open
  }, [open])

  // Recency, kept as the workspace changes under us — the wall orders by it so
  // the one you were last in sits beside the one you are in. While the wall
  // is up the list follows too, so a removal is a screen gone, not a screen
  // that cannot be entered.
  useEffect(
    () =>
      cookrew().onWorkspaceList((next) => {
        if (next.activeId) {
          recentRef.current = [next.activeId, ...recentRef.current.filter((id) => id !== next.activeId)]
        }
        if (openRef.current) setList(next)
      }),
    []
  )

  /**
   * THE CHIP TOGGLES, AND IT NEVER PHOTOGRAPHS ITS OWN WALL.
   *
   * Clicking the chip a second time is the natural way to dismiss the wall,
   * and without this guard that click ran a fresh capture WITH THE WALL ON
   * SCREEN — so the workspace's snapshot became a picture of the switcher,
   * and the next open showed a wall inside a wall. Found by using it, not by
   * a test: nothing about the code reads wrong, it is purely a question of
   * what is painted at the moment the compositor is asked for a frame.
   */
  const openWall = useCallback(async () => {
    if (openRef.current) {
      setOpen(false)
      return
    }
    const rect = stageRef.current?.getBoundingClientRect() ?? null
    setStage(rect)
    // PHOTOGRAPH THE CANVAS FIRST. Opening the wall is the moment this
    // workspace stops being looked at, and it is still on screen right now —
    // so its own screen in the wall is current rather than a memory.
    if (rect) {
      await cookrew()
        .snapWorkspace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .catch(() => false)
    }
    // The saved teams are refetched every open, not once: the dock's SAVE can
    // add one at any point, and a stale list would make that save look like
    // it never happened when creating from a template.
    const [nextList, nextShots, nextTeams] = await Promise.all([
      cookrew().listWorkspaces().catch(() => null),
      cookrew().workspaceShots().catch(() => ({})),
      cookrew().teamList().catch(() => [] as TeamMeta[]),
    ])
    if (nextList) {
      setList(nextList)
      if (recentRef.current.length === 0 && nextList.activeId) recentRef.current = [nextList.activeId]
    }
    setShots(nextShots)
    setTeams(nextTeams)
    setOpen(true)
  }, [stageRef])

  const close = useCallback(() => setOpen(false), [])

  const enter = useCallback(
    (id: string) => {
      if (id !== list?.activeId) void cookrew().switchWorkspace(id)
    },
    [list?.activeId]
  )

  // From a template: the backend reuses the fork-from-saved machinery to boot
  // the new workspace pre-populated (nodes, roles, session snapshots). It
  // switches to the new one itself, so the wall simply closes.
  const create = useCallback((request: { name: string; dir: string; template: string | null }) => {
    void cookrew().createWorkspace(request.name, request.dir, request.template ?? undefined)
    setOpen(false)
  }, [])

  const remove = useCallback(
    (id: string) => {
      if (!list) return
      const plan = planRemove(list, id)
      if (!plan.ok) return
      if (plan.switchTo) void cookrew().switchWorkspace(plan.switchTo)
      void removeWorkspace(id)
        .then(() => cookrew().listWorkspaces().then(setList))
        .catch((error: unknown) => console.error('Remove workspace failed:', error))
    },
    [list]
  )

  // The directory manager is its own panel, and it sits BELOW the wall in the
  // stacking order — so the wall steps aside for it, as the dropdown did.
  const directories = useCallback(
    (id: string) => {
      const meta = list?.workspaces.find((w) => w.id === id)
      if (!meta) return
      setOpen(false)
      setDirs(meta)
    },
    [list]
  )

  /**
   * Built only while the wall is up — it walks every node, and the wall is
   * looked at for two seconds. Keyed by the live id, because that is the only
   * workspace whose state this renderer holds.
   */
  const maps = useMemo(() => {
    if (!open || !workspace || !list?.activeId) return {}
    const map = workspaceMap(workspace)
    return map.cells.length === 0 ? {} : { [list.activeId]: map }
  }, [open, workspace, list?.activeId])

  const activity = useCallback(() => {
    setOpen(false)
    onActivity()
  }, [onActivity])

  const element = (
    <>
      <WorkspaceWall
        open={open}
        workspaces={(list?.workspaces ?? []).map((w) => ({ id: w.id, name: w.name, icon: w.icon, dir: w.dir }))}
        activeId={list?.activeId ?? ''}
        recent={recentRef.current}
        shots={shots}
        maps={maps}
        stage={stage}
        teams={teams}
        canRemove={(list?.workspaces.length ?? 0) > 1}
        canPickDir={hasNativeDirPicker()}
        pickDir={pickDirectory}
        onEnter={enter}
        onClose={close}
        onCreate={create}
        onDirectories={directories}
        onRemove={remove}
        onActivity={activity}
      />
      {dirs && <DirectoryManager meta={dirs} onClose={() => setDirs(null)} />}
    </>
  )

  return { open: () => void openWall(), element }
}
