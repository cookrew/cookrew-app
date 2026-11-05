import { thisMachine } from '../../shared/machine-word'

/**
 * "this Mac" or "this computer", from the renderer. A phone is not the machine it
 * is talking to, so only a Mac's own window says Mac; the neutral word is true
 * from everywhere else.
 */
export const hostMachine = (): string =>
  thisMachine(typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform) ? 'darwin' : 'other')
