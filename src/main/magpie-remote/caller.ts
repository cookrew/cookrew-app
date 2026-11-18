import { execFile } from 'node:child_process'
import { readlinkSync, realpathSync, statSync } from 'node:fs'

/**
 * WHO IS CALLING THE FORWARDER (forward.ts). The forwarder puts the owner's key for
 * another computer's Magpie on every request, so it serves only THIS computer's Magpie:
 * a connection is answered only when the process at its other end runs as this user and
 * is the magpie binary (the app's gateway, or its CLI listing a new provider's models).
 * Another OS user, a served seat left from an older build, any other local program: refused.
 * Anything that cannot be read is refused (fail closed).
 */

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
    const out = await run('ss', ['-Htnp', `sport = :${clientPort}`])
    return out === null ? null : parseSsPids(out, clientPort)
  }
  const out = await run('lsof', ['-nP', `-iTCP@127.0.0.1:${clientPort}`, '-sTCP:ESTABLISHED', '-Fp'])
  return out === null ? null : parseLsofPids(out).filter((pid) => pid !== process.pid)
}

interface ProcessFacts {
  readonly uid: number
  readonly exe: string
}

async function facts(pid: number): Promise<ProcessFacts | null> {
  try {
    if (process.platform === 'linux') {
      return { uid: statSync(`/proc/${pid}`).uid, exe: readlinkSync(`/proc/${pid}/exe`) }
    }
    const out = await run('ps', ['-o', 'uid=,comm=', '-p', String(pid)])
    const m = out?.trim().match(/^(\d+)\s+(\/.+)$/)
    return m ? { uid: Number(m[1]), exe: m[2] } : null
  } catch {
    return null
  }
}

const real = (file: string): string | null => {
  try {
    return realpathSync(file)
  } catch {
    return null
  }
}

/** Is the process at the far end of this loopback connection this user's magpie? */
export async function callerIsMagpie(clientPort: number, magpieBin: string | null): Promise<boolean> {
  if (magpieBin === null || typeof process.getuid !== 'function') return false
  const want = real(magpieBin)
  if (want === null) return false
  const pids = await clientPids(clientPort)
  if (pids === null || pids.length !== 1) return false
  const f = await facts(pids[0])
  if (f === null || f.uid !== process.getuid()) return false
  return real(f.exe) === want
}
