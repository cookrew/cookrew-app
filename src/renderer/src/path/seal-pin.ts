import type { SealVersionPin } from './seal-client'

/**
 * "THIS CODE'S MAC SPEAKS cookrew-seal/2", remembered per machine and per code.
 *
 * Once a Mac answered v2 on a code, a v1 answer on that same code can only mean a
 * carrier stripped the offer, so it is refused (path/seal-client.ts). The pin is
 * tied to the code itself: a new code (scanned, or the Mac's replacement) starts
 * unpinned, so a Mac that was put back to an older version is reached again by
 * scanning its code once.
 */

const TAG = 12
const pinKey = (codeKey: string): string => `${codeKey}:seal2`

export function sealPinFor(codeKey: string, code: string, storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage): SealVersionPin {
  const tag = code.slice(0, TAG)
  return {
    v2: () => {
      try {
        return storage.getItem(pinKey(codeKey)) === tag
      } catch {
        return false
      }
    },
    sawV2: () => {
      try {
        storage.setItem(pinKey(codeKey), tag)
      } catch {
        // Storage refused (private mode, quota): the pin is a hardening, the session still opened sealed.
      }
    }
  }
}
