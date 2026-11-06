import { mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import type { SecretSealer } from './secrets-store'

/**
 * THE MACHINE SWITCH, ACROSS A RESTART (owner 2026-11-06: set up once at the Mac, then
 * work from anywhere). Off at every launch meant one restart cut off a phone that was
 * nowhere near the Mac.
 *
 * An agent running as this user can write any file, so a file alone turns nothing on.
 * What is kept is a mark sealed under the app's own keychain key (secrets-seal.ts).
 * A dev run and the packaged app hold different keys, so each is set on once.
 *
 * THE LIMITS: on a dev run, code run as the same unsigned Electron can open that key;
 * a signed build closes that. And a copy of the file taken while it was on would turn
 * it back on if put back after it was turned off. Taking the file away only turns it off.
 */

const ON = 'cookrew-remote-switch-on/1'

export interface SwitchMemory {
  read(): boolean
  write(on: boolean): void
}

export function sealedSwitchMemory(file: string, sealer: SecretSealer): SwitchMemory {
  return {
    read() {
      try {
        return sealer.open(Buffer.from(readFileSync(file, 'utf8'), 'base64')) === ON
      } catch {
        // None yet, damaged, or sealed under another key: off, which is safe.
        return false
      }
    },
    write(on) {
      if (!on) return rmSync(file, { force: true })
      if (!sealer.available()) throw new Error('There is no key to keep the switch under.')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(file, sealer.seal(ON).toString('base64'))
      chmodSync(file, 0o600)
    }
  }
}
