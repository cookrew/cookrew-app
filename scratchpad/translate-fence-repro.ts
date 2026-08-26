/**
 * Repro: translating a checkpoint that contains a fenced code block glues the
 * closing fence to the paragraph after it, and the renderer's markdown parser
 * then swallows the whole remainder of the reply into the code block.
 *
 * No model involved — splitForTranslation drops the blank line after a fence,
 * because splitKeeping emits it as its own empty "paragraph" which the
 * `para.trim().length === 0` guard discards.
 *
 *   npx tsx scratchpad/translate-fence-repro.ts
 */
import { splitForTranslation } from '../src/shared/translate'
import { parseMarkdown } from '../src/renderer/src/markdown'

const SRC =
  'Intro line.\n\n```bash\nnpm test\n```\n\nAfterwards it is green.\n\nAnd this last paragraph matters.\n'

const glued = splitForTranslation(SRC).join('')
const blocks = (s: string): string =>
  JSON.stringify((parseMarkdown(s) as { type: string; value?: string }[]).map((b) => b.type))

console.log('splitter round-trips :', glued === SRC)
console.log('original  blocks     :', blocks(SRC))
console.log('translated blocks    :', blocks(glued))
console.log('glued text           :', JSON.stringify(glued))
