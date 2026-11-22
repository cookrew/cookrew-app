import type { SealVersionPin } from './seal-client'

/**
 * "THIS MACHINE SPEAKS cookrew-seal/2", remembered per machine.
 *
 * Once a machine answered v2, a v1 answer from it can only mean a carrier took the
 * offer off the hello, so it is refused (path/seal-client.ts), whatever code is held
 * for it: a new code (a rotation, a scan) does not reopen the plain way. Nothing in
 * this page ever unpins a machine. Going back to a Mac from before v2 means going
 * back to a console from before v2 as well, which never reads this.
 */

const pinKey = (codeKey: string): string => `${codeKey}:seal2`

export function sealPinFor(codeKey: string, storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage): SealVersionPin {
  return {
    v2: () => {
      try {
        return storage.getItem(pinKey(codeKey)) !== null
      } catch {
        return false
      }
    },
    sawV2: () => {
      try {
        storage.setItem(pinKey(codeKey), '2')
      } catch {
        // Storage refused (private mode, quota): the pin is a hardening, the session still opened sealed.
      }
    }
  }
}
