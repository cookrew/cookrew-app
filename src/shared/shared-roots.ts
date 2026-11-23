/**
 * THE FOLDERS THIS COMPUTER SHARES WITH ITS OWN DEVICES (owner, 2026-11-23).
 *
 * A workspace's directories are shared already: that is where agents write. The
 * owner may name MORE folders — a documents folder, a media library — and this
 * computer then answers for them the way a NAS would: a device lists them and
 * reads their files over the sealed link, and renders or saves locally.
 *
 * WHAT IS SHARED IS THE OWNER'S TO SAY, never a client's: the list lives on this
 * computer (`~/.cookrew/shared-roots.json`), a device can only ask for a path
 * INSIDE one of these roots, and the path is resolved (links followed) before it
 * is answered. A root is not "the disk": it is one folder, named by the person
 * whose files they are.
 */

export interface SharedRootsFile {
  /** Absolute paths, as the owner typed them. Relative or empty entries are ignored. */
  readonly roots?: readonly unknown[]
}

/** The file's shape, kept simple on purpose: a person may write it by hand. */
export function parseSharedRoots(raw: unknown): string[] {
  const list = (raw as SharedRootsFile | null | undefined)?.roots
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (!value.startsWith('/')) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** Workspace directories first (they are always shared), then the owner's own, once each. */
export function sharedRoots(workspaceDirs: readonly string[], granted: readonly string[]): string[] {
  const out: string[] = []
  for (const dir of [...workspaceDirs, ...granted]) {
    if (typeof dir !== 'string' || dir.trim() === '' || !dir.startsWith('/')) continue
    if (!out.includes(dir)) out.push(dir)
  }
  return out
}

/** A path a device asked for, as a relative path inside a root; null when it could leave it. */
export function safeRelative(asked: string): string | null {
  if (typeof asked !== 'string') return null
  const trimmed = asked.replace(/^\/+/, '')
  if (trimmed.includes('\0')) return null
  const parts = trimmed.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.join('/')
}

/** Is this resolved path inside that resolved root? */
export function inside(root: string, file: string): boolean {
  const clean = root.endsWith('/') ? root : `${root}/`
  return file === root || file.startsWith(clean)
}
