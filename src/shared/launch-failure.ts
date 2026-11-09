/**
 * WHY A CARD IS NOT RUNNING, when it did not simply go to sleep.
 *
 * Box test 2, bug 2: a card whose command or folder was missing said OFFLINE,
 * "— process exited —" and "asleep · wakes on send", and the words sent to it
 * went nowhere. A wake that cannot work is not a promise to make.
 */
export interface LaunchFailure {
  /** folder-untrusted: Claude would sit on its trust question, which Cookrew does not answer for a broad folder. */
  kind: 'folder-missing' | 'folder-not-directory' | 'folder-untrusted' | 'command-missing' | 'exited'
  /** One line: what is wrong, naming the folder or the command. */
  why: string
  /** One line: what to do about it. */
  fix: string
  /**
   * True when the app KNOWS a boot would fail the same way, so nothing may
   * promise one. False for a process that started and died: a retry can work.
   */
  blocked: boolean
  /** Null when the backend could not say (herdr does not report one). */
  exitCode: number | null
  /** The last things it printed, oldest first. */
  lastLines: readonly string[]
  at: number
}
