import { useEffect, useState } from 'react'
import type { WorkspaceList } from '../../shared/model'
import { cookrew } from './api'

export interface ActiveWorkspace {
  name: string
  icon: string
  dir: string
}

/**
 * The workspace the canvas is on, as the header's route names it.
 *
 * This was a chip of its own at the right of the bar — one door to the screen
 * wall (WorkspaceWall.tsx), which switches, makes and manages workspaces. The
 * bar is a route now (device / workspace / agent), and its workspace step
 * lands on the workspace choice in the levels; the wall moved to the More
 * menu. What is left here is the name, the icon and the directory.
 */
export function useActiveWorkspace(fallbackName: string, fallbackDir: string): ActiveWorkspace {
  const [list, setList] = useState<WorkspaceList | null>(null)

  useEffect(() => {
    void cookrew().listWorkspaces().then(setList)
    return cookrew().onWorkspaceList(setList)
  }, [])

  const active = list?.workspaces.find((w) => w.id === list.activeId)
  return {
    name: active?.name ?? fallbackName,
    icon: active?.icon ?? '🗂',
    dir: active?.dir ?? fallbackDir
  }
}
