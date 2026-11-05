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
 */

export const machineWord = (platform: string): 'Mac' | 'PC' | 'machine' => {
  if (platform === 'darwin') return 'Mac'
  return platform === 'win32' ? 'PC' : 'machine'
}

/** One sentence, in this platform's word. Undefined claims nothing. */
export function machineCopy(sentence: string, platform: string | undefined): string {
  if (platform === undefined || platform === 'darwin') return sentence
  const word = machineWord(platform)
  return sentence.replace(/\bMac\b/g, word).replace(/\bMAC\b/g, word.toUpperCase())
}

/** Every sentence in a table. The same table back when nothing would change. */
export function machineTable<T extends Readonly<Record<string, string>>>(table: T, platform: string | undefined): T {
  if (platform === undefined || platform === 'darwin') return table
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
