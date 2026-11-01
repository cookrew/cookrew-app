import { useEffect, useState } from 'react'
import { cookrew } from '../api'

/**
 * Each harness's launch command, by preset name: the box's tune chip asks it
 * which model and effort a new agent of that harness can start on
 * (shared/launch-tune). Asked once per app: the presets are main's constant.
 */

let asked: Promise<ReadonlyMap<string, string>> | null = null

function presetCommands(): Promise<ReadonlyMap<string, string>> {
  if (asked === null) {
    asked = Promise.resolve()
      .then(() => cookrew().listPresets())
      .then((list) => new Map(list.map((p) => [p.name, p.command] as const)))
      .catch((error: unknown) => {
        // Asked again next time: a bridge that was not up yet is no answer.
        asked = null
        throw error
      })
  }
  return asked
}

const NONE: ReadonlyMap<string, string> = new Map()

export function usePresetCommands(): ReadonlyMap<string, string> {
  const [commands, setCommands] = useState<ReadonlyMap<string, string>>(NONE)
  useEffect(() => {
    let live = true
    presetCommands()
      .then((map) => {
        if (live) setCommands(map)
      })
      .catch((error: unknown) => console.error('The presets could not be read for the tune chip:', error))
    return () => {
      live = false
    }
  }, [])
  return commands
}
