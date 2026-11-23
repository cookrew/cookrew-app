import type { FileEntry, FileRoot, Listing } from '../../../main/file-server'

export type FilesRoots = { readonly roots: readonly FileRoot[] }

type JsonObject = Record<string, unknown>
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null

function isRoot(value: unknown): value is FileRoot {
  return isObject(value) && typeof value.name === 'string' && typeof value.path === 'string' && value.path.startsWith('/')
}

function isEntry(value: unknown): value is FileEntry {
  if (!isObject(value)) return false
  const { name, kind, size, mtimeMs, mime } = value
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0') &&
    (kind === 'dir' || kind === 'file' || kind === 'other') &&
    typeof size === 'number' && Number.isFinite(size) && typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) &&
    (mime === undefined || typeof mime === 'string')
}

export async function decodeFilesRoots(response: Response): Promise<FilesRoots> {
  const value: unknown = await response.json()
  if (!isObject(value) || !Array.isArray(value.roots) || !value.roots.every(isRoot)) throw new Error('Invalid shared folders')
  return { roots: value.roots }
}

export async function decodeFilesListing(response: Response): Promise<Listing> {
  const value: unknown = await response.json()
  if (!isObject(value)) throw new Error('Invalid folder listing')
  const { path, entries, truncated } = value
  if (typeof path !== 'string' || !Array.isArray(entries) || !entries.every(isEntry) || typeof truncated !== 'boolean') {
    throw new Error('Invalid folder listing')
  }
  return { path, entries, truncated }
}
