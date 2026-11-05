/**
 * THE WORD FOR THE MACHINE IN FRONT OF YOU.
 *
 * The account's sentences were written on a Mac, and on the Solis Linux box
 * they went on saying "this Mac". A Mac keeps its own word, because the copy
 * names things rather than describing them; Windows says PC; anything else is
 * a machine.
 *
 * THE SENTENCES STAY WRITTEN AS THEY ARE. One rewrite at the table beats
 * ninety `{machine}` placeholders: a new sentence cannot forget it, and the
 * tables below keep reading as the design's copy table. It runs on the TABLE,
 * before any placeholder is filled, so a device called "Mac mini · studio"
 * keeps its name in the middle of a sentence on a Linux box.
 *
 * WHO DOES NOT KNOW SAYS NOTHING. The site and a phone are not the machine the
 * sentence is about, so they pass undefined and the sentence stands.
 *
 * THE REGISTRY GOES THE SAME WAY. The sentences say cookrew.dev; with another
 * registry set, "It goes only to cookrew.dev" is untrue about where a password
 * went. The word comes from the origin the app really talks to.
 */

export const machineWord = (platform: string): 'Mac' | 'PC' | 'machine' => {
  if (platform === 'darwin') return 'Mac'
  return platform === 'win32' ? 'PC' : 'machine'
}

const HOME_REGISTRY = 'cookrew.dev'
const REGISTRY_FLAG = '--cookrew-registry='

/** What a registry is called in a sentence: its host. Undefined when that is what the sentences say already. */
export function registryWord(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const { host } = new URL(origin)
    return host === '' || host === HOME_REGISTRY ? undefined : host
  } catch {
    return undefined
  }
}

/** One sentence, in this registry's word. Undefined claims nothing. */
export function registryCopy(sentence: string, word: string | undefined): string {
  return word === undefined ? sentence : sentence.replace(/\bcookrew\.dev\b/g, word)
}

/** How main hands the origin to the preload: a window has no environment of its own. */
export const registryArgument = (origin: string): string => `${REGISTRY_FLAG}${origin}`

/** The origin main handed this window, or nothing. */
export function registryFromArgv(argv: readonly string[]): string {
  return argv.find((arg) => arg.startsWith(REGISTRY_FLAG))?.slice(REGISTRY_FLAG.length) ?? ''
}

/** The registry the preload published for this page, as a word (see hostPlatform). */
export function hostRegistry(): string | undefined {
  const held = (globalThis as { cookrewRegistry?: unknown }).cookrewRegistry
  return typeof held === 'string' ? registryWord(held) : undefined
}

/** One sentence, in this platform's word and this window's registry. Undefined claims nothing. */
export function machineCopy(sentence: string, platform: string | undefined): string {
  const said = registryCopy(sentence, hostRegistry())
  if (platform === undefined || platform === 'darwin') return said
  const word = machineWord(platform)
  return said.replace(/\bMac\b/g, word).replace(/\bMAC\b/g, word.toUpperCase())
}

/** Every sentence in a table. The same table back when nothing would change. */
export function machineTable<T extends Readonly<Record<string, string>>>(table: T, platform: string | undefined): T {
  if ((platform === undefined || platform === 'darwin') && hostRegistry() === undefined) return table
  const rewritten = Object.entries(table).map(([key, sentence]) => [key, machineCopy(sentence, platform)])
  return Object.fromEntries(rewritten) as unknown as T
}

/**
 * The platform the preload published for this page (preload/index.ts).
 *
 * A global because the tables are built as their modules load, ahead of any
 * call a component could make, and the preload is the one thing that runs
 * before them. Only the desktop's own window has it.
 */
export function hostPlatform(): string | undefined {
  const held = (globalThis as { cookrewPlatform?: unknown }).cookrewPlatform
  return typeof held === 'string' ? held : undefined
}
