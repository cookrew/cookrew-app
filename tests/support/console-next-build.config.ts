/**
 * THE CONSOLE'S NEXT BUILD, for a suite that needs two: the same build
 * (vite.console.config.ts) with one more statement in its entry. The entry's
 * bytes change, so its name does, and so does the name of every chunk that
 * imports it: a build as different from the first as the next release is.
 */
import type { Plugin, UserConfig } from 'vite'
import base from '../../vite.console.config'

const nextBuild = (): Plugin => ({
  name: 'cookrew-console-next-build',
  transform(code, id) {
    if (!id.endsWith('/src/renderer/src/console-main.tsx')) return null
    // Plain JavaScript: by the time this runs the entry may already be compiled.
    return { code: `${code}\n;globalThis.cookrewConsoleNextBuild = true\n`, map: null }
  }
})

const config = base as UserConfig
export default { ...config, plugins: [nextBuild(), ...(config.plugins ?? [])] } satisfies UserConfig
