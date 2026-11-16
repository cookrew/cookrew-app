/**
 * cookrewd's entry: refuse to boot unless isolated (isolation.ts), then load
 * the main process. The check runs before a single main-process module is
 * evaluated, because those modules start working as they load.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { isolationProblems } from './isolation'

const EX_CONFIG = 78

const problems = isolationProblems({
  env: process.env,
  liveUserData: path.join(homedir(), 'Library', 'Application Support', 'cookrew')
})

if (problems.length > 0) {
  console.error(`[cookrewd] refusing to boot:\n  - ${problems.join('\n  - ')}\nRun it through \`npm run daemon:smoke\`, which isolates it.`)
  process.exit(EX_CONFIG)
}

/**
 * The parent holds our stdin open; when it goes (killed, crashed), so do we,
 * instead of being left listening on the network with nobody to stop us.
 */
if (process.env.COOKREWD_PARENT_PIPE === '1') {
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
  process.stdin.resume()
}

await import('../index')
