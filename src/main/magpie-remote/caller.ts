import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

/**
 * WHO IS CALLING THE FORWARDER (forward.ts). The forwarder puts the owner's key for
 * another computer's Magpie on every request, so it serves only THIS computer's Magpie:
 * a connection is answered only when the process at its other end runs as this user and
 * its executable, as the kernel names it (never argv[0], which any program sets), is the
 * magpie binary by device and inode (the app's gateway, or its CLI listing a new
 * provider's models). Anything that cannot be read is refused (fail closed).
 *
 * DEFENCE IN DEPTH, NOT THE BOUNDARY: Magpie on loopback answers any local process with no
 * key (0.1.3935), and would relay its request to a Remote magpie provider itself. What
 * holds another computer's spend is the cap on the key that computer gave (serve.ts).
 */

/** The tools, by absolute path: a PATH entry must not decide who is let in. */
const LSOF = '/usr/sbin/lsof'
const PS = '/bin/ps'
const SS = ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss'].find((p) => existsSync(p)) ?? '/usr/bin/ss'

const run = (bin: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 3_000 }, (error, stdout) => resolve(error ? null : String(stdout)))
  })

/** `lsof -nP -iTCP@127.0.0.1:<port> -sTCP:ESTABLISHED -Fp` lines: `p<pid>`. */
export function parseLsofPids(text: string): number[] {
  return [...new Set(text.split('\n').flatMap((line) => (/^p\d+$/.test(line.trim()) ? [Number(line.trim().slice(1))] : [])))]
}

/** `ss -Htnp` lines whose local address is 127.0.0.1:<port>: the pids that own them. */
export function parseSsPids(text: string, port: number): number[] {
  const pids: number[] = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/)
    if (cells.length < 5 || cells[3] !== `127.0.0.1:${port}`) continue
    pids.push(...[...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))
  }
  return [...new Set(pids)]
}

/** The pids holding the client end of a loopback connection from `clientPort`, or null when unreadable. */
async function clientPids(clientPort: number): Promise<number[] | null> {
  if (process.platform === 'linux') {
    const out = await run(SS, ['-Htnp', `sport = :${clientPort}`])
    return out === null ? null : parseSsPids(out, clientPort)
  }
  const out = await run(LSOF, ['-nP', `-iTCP@127.0.0.1:${clientPort}`, '-sTCP:ESTABLISHED', '-Fp'])
  return out === null ? null : parseLsofPids(out).filter((pid) => pid !== process.pid)
}

interface ProcessFacts {
  readonly uid: number
  /** The executable's device and inode, as the kernel has it mapped. */
  readonly exe: string
}

const fileId = (file: string): string | null => {
  try {
    const s = statSync(file)
    return `${s.dev}:${s.ino}`
  } catch {
    return null
  }
}

/** `lsof -a -p <pid> -d txt -Fn`: the first text mapping is the executable the kernel loaded. */
export function parseLsofExe(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim())
  const at = lines.findIndex((l) => l === 'ftxt')
  const name = at >= 0 ? lines.slice(at + 1).find((l) => l.startsWith('n')) : undefined
  return name === undefined || !name.startsWith('n/') ? null : name.slice(1)
}

async function facts(pid: number): Promise<ProcessFacts | null> {
  try {
    if (process.platform === 'linux') {
      const exe = fileId(`/proc/${pid}/exe`)
      return exe === null ? null : { uid: statSync(`/proc/${pid}`).uid, exe }
    }
    const uid = (await run(PS, ['-o', 'uid=', '-p', String(pid)]))?.trim() ?? ''
    const path = parseLsofExe((await run(LSOF, ['-a', '-p', String(pid), '-d', 'txt', '-Fn'])) ?? '')
    const exe = path === null ? null : fileId(path)
    return /^\d+$/.test(uid) && exe !== null ? { uid: Number(uid), exe } : null
  } catch {
    return null
  }
}

/** Is the process at the far end of this loopback connection this user's magpie? */
export async function callerIsMagpie(clientPort: number, magpieBin: string | null): Promise<boolean> {
  if (magpieBin === null || typeof process.getuid !== 'function') return false
  const want = fileId(magpieBin)
  if (want === null) return false
  const pids = await clientPids(clientPort)
  if (pids === null || pids.length !== 1) return false
  const f = await facts(pids[0])
  if (f === null || f.uid !== process.getuid()) return false
  return f.exe === want
}
