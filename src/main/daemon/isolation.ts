/**
 * WHEN cookrewd MAY BOOT (D0 of the move off Electron).
 *
 * The daemon is the whole main process. If it can reach the live herdr
 * session (its name is hard-coded) or shares the live app's userData, it can
 * take the live app's session claim and reap its panes: a second instance
 * once closed 56 of them. Until the daemon replaces the app for real, it boots
 * only when it is provably on its own: its own userData, and no herdr on its
 * PATH. Pure, so the rule is tested without booting anything.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface IsolationInput {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The live app's userData (~/Library/Application Support/cookrew). */
  readonly liveUserData: string
  /** Does this file exist (injected for tests). */
  readonly exists?: (file: string) => boolean
}

/** Why this daemon must not boot here; empty when it may. */
export function isolationProblems(input: IsolationInput): readonly string[] {
  const exists = input.exists ?? existsSync
  const { env } = input
  const problems: string[] = []
  const userData = env.COOKREWD_USER_DATA
  if (!userData) {
    problems.push('COOKREWD_USER_DATA is not set: the daemon would share the live app\'s userData')
  } else if (path.resolve(userData) === path.resolve(input.liveUserData)) {
    problems.push('COOKREWD_USER_DATA is the live app\'s own userData')
  }
  if (env.COOKREWD_ALLOW_HERDR !== '1') {
    const reachable = (env.PATH ?? '')
      .split(':')
      .filter((dir) => dir.length > 0)
      .map((dir) => path.join(dir, 'herdr'))
      .filter((file) => exists(file))
    if (reachable.length > 0) problems.push(`herdr is reachable on PATH (${reachable.join(', ')}): the live fleet's session could be taken`)
    if (env.HERDR_SOCKET_PATH || env.HERDR_SESSION) problems.push('HERDR_SOCKET_PATH or HERDR_SESSION is set: the daemon would speak to a live herdr')
  }
  return problems
}
