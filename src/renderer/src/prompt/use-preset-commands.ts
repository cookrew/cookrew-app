import { registerScopeState } from '../machine-scope'
import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { launchOffer, type LaunchOffer } from '../../../shared/launch-tune'

/**
 * What a new agent of each harness can start on, by preset name: the box's
 * tune chip offers it (shared/launch-tune). Main reads it off each harness's
 * own catalog (main/launch-offers.ts) and sends it with the preset list; a
 * main too old to send it still gets claude's, which this side knows.
 * Asked once per app: the presets are main's constant.
 */

let asked: Promise<ReadonlyMap<string, LaunchOffer | null>> | null = null

// The presets are the machine's own: asked again of the next one.
registerScopeState('preset offers', () => {
  asked = null
})

function presetOffers(): Promise<ReadonlyMap<string, LaunchOffer | null>> {
  if (asked === null) {
    asked = Promise.resolve()
      .then(() => cookrew().listPresets())
      .then((list) => new Map(list.map((p) => [p.name, p.launch === undefined ? launchOffer(p.command) : p.launch] as const)))
      .catch((error: unknown) => {
        // Asked again next time: a bridge that was not up yet is no answer.
        asked = null
        throw error
      })
  }
  return asked
}

const NONE: ReadonlyMap<string, LaunchOffer | null> = new Map()

export function usePresetOffers(): ReadonlyMap<string, LaunchOffer | null> {
  const [offers, setOffers] = useState<ReadonlyMap<string, LaunchOffer | null>>(NONE)
  useEffect(() => {
    let live = true
    presetOffers()
      .then((map) => {
        if (live) setOffers(map)
      })
      .catch((error: unknown) => console.error('The presets could not be read for the tune chip:', error))
    return () => {
      live = false
    }
  }, [])
  return offers
}
