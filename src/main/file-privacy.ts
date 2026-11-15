/**
 * Whether a file's POSIX permission bits let anyone but its owner in.
 *
 * Windows has no such bits: `stat` reports 0o666 for every file that is not
 * read-only, whatever its ACL says, and a user's profile is already private to
 * them. Reading the bits there refused every key this app had just written at
 * 0600, so on win32 they are not evidence and nothing is refused on them.
 */
export function openToOthers(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o077) !== 0
}
