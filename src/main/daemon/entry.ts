/**
 * cookrewd's entry: close the debugger door, refuse to boot unless isolated
 * (isolation.ts), then load the main process. The checks run before a single
 * main-process module is evaluated, because those modules start working as
 * they load.
 */
// FIRST: takes SIGUSR1 so no inspector can be opened from outside (no-inspector.ts).
import { currentInspectorProblems } from './no-inspector'
import { homedir } from 'node:os'
import path from 'node:path'
import { isolationProblems } from './isolation'

const EX_CONFIG = 78

const problems = [
  ...currentInspectorProblems(),
  ...isolationProblems({
    env: process.env,
    liveUserData: path.join(homedir(), 'Library', 'Application Support', 'cookrew')
  })
]

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

/** The owner's end of a socket pair, passed as an extra stdio descriptor (owner-link.ts). */
const ownerFd = Number(process.env.COOKREWD_OWNER_FD ?? '')

await import('../index')

if (Number.isInteger(ownerFd) && ownerFd > 2) {
  const { Socket } = await import('node:net')
  const { startOwnerLink } = await import('./owner-link')
  const shim = await import('./electron-shim')
  const pipe = new Socket({ fd: ownerFd, readable: true, writable: true })
  const link = startOwnerLink(pipe, pipe, shim.ownerDispatch)
  // Events the window sent before this line are held by the shim and handed over now.
  shim.connectOwner((channel, args) => {
    link.emit(channel, args)
  })
  // The owner's app launched this daemon; when it lets go, the daemon goes,
  // as the app's main process did when its window closed for good.
  void link.closed.then(() => {
    shim.connectOwner(null)
    shim.app.quit()
  })
}
