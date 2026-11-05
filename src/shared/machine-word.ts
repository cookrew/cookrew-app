/**
 * WHAT THE APP CALLS THE COMPUTER IT RUNS ON. It says Mac on a Mac and "computer"
 * anywhere else: a box user test on Ubuntu read "this Mac" in every corner.
 * Account copy (shared/account-copy.ts) has its own owner and is not this file's.
 */
export const thisMachine = (platform: string): string => (platform === 'darwin' ? 'this Mac' : 'this computer')

/** The same word at the start of a sentence. */
export const TheMachine = (platform: string): string => (platform === 'darwin' ? 'This Mac' : 'This computer')
