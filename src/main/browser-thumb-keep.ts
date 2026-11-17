// THE LAST PICTURE OF EACH BROWSER, KEPT ON DISK (owner 2026-11-16: "三端都没有渲染出
// 第一页的artifact"). The cache only ever held what a running headless page gave it,
// in memory: a browser nobody had opened since the app started, or one in a workspace
// nobody is in, had no picture at all, and every workspace tile's front page fell back
// to its drawing on the desktop, the console and the watch alike. The last frame of
// each browser is written here as it changes and read back when the cache has none,
// so a tile shows the page as it was last seen, until a running page gives a newer one.

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ThumbKeep, ThumbType } from './browser-thumb-cache'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const EXT: Record<ThumbType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' }

export function browserThumbKeep(dir = path.join(homedir(), '.cookrew', 'browser-thumbs')): ThumbKeep {
  const file = (id: string, type: ThumbType): string => path.join(dir, `${id}.${EXT[type]}`)
  return {
    load(id) {
      if (!SAFE_ID.test(id)) return null
      for (const type of ['image/jpeg', 'image/png'] as const) {
        try {
          const at = statSync(file(id, type)).mtimeMs
          return { data: readFileSync(file(id, type)), type, at }
        } catch {
          // Not kept in this type.
        }
      }
      return null
    },
    save(id, data, type) {
      if (!SAFE_ID.test(id)) return
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {
        return
      }
      const other = file(id, type === 'image/jpeg' ? 'image/png' : 'image/jpeg')
      void rm(other, { force: true })
        .then(() => writeFile(file(id, type), data, { mode: 0o600 }))
        .catch((error: unknown) => console.error(`Keeping the browser thumbnail failed (${id}):`, error))
    },
    drop(id) {
      if (!SAFE_ID.test(id)) return
      for (const type of ['image/jpeg', 'image/png'] as const) void rm(file(id, type), { force: true }).catch(() => undefined)
    }
  }
}
