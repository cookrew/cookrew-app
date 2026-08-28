import { splitForTranslation } from '../src/shared/translate'
import { parseMarkdown } from '../src/renderer/src/markdown'
const cases: [string,string][] = [
  ['single fence mid-body',   'Intro.\n\n```bash\nnpm test\n```\n\nAfter.\n'],
  ['two fences',              'A.\n\n```ts\nconst x=1\n```\n\nB.\n\n```ts\nconst y=2\n```\n\nC.\n'],
  ['fence at very start',     '```sh\nls -la\n```\n\nThen the prose.\n'],
  ['fence at EOF no newline', 'Prose first.\n\n```sh\nls\n```'],
  ['unclosed fence',          'Prose.\n\n```sh\nls -la\nrm -rf tmp\n'],
  ['back-to-back fences',     '```a\n1\n```\n```b\n2\n```\n'],
  ['single newline sep',      'Line one.\n```sh\nls\n```\nLine two.\n'],
  ['CRLF body',               'Intro.\r\n\r\n```sh\r\nls\r\n```\r\n\r\nAfter.\r\n'],
  ['fence in a list item',    '- step one\n\n  ```sh\n  ls\n  ```\n\n- step two\n'],
  ['trailing spaces on fence','Intro.\n\n```sh   \nls\n```   \n\nAfter.\n'],
  ['3+ blank lines',          'A.\n\n\n\n```sh\nls\n```\n\n\n\nB.\n'],
  ['leading/trailing blanks', '\n\nOnly prose here.\n\n'],
  ['whitespace-only body',    '   \n\n  \n'],
  ['tilde-ish inline code',   'Path `~/.claude/projects` and `a\\`b`.\n\n```\nraw\n```\n\nEnd.\n'],
  ['very long no-seam blob',  'Intro.\n\n' + 'x'.repeat(9000) + '\n\nAfter.\n'],
]
const types = (s: string) => JSON.stringify((parseMarkdown(s) as {type:string}[]).map(b=>b.type))
let bad = 0
for (const [name, src] of cases) {
  const out = splitForTranslation(src).join('')
  const rt = out === src
  const same = types(src) === types(out)
  if (!rt || !same) { bad++
    console.log(`FAIL  ${name}`)
    console.log(`   round-trip: ${rt}  blocks-match: ${same}`)
    if (!rt) console.log(`   src: ${JSON.stringify(src.slice(0,90))}\n   got: ${JSON.stringify(out.slice(0,90))}`)
    if (!same) console.log(`   src blocks: ${types(src)}\n   got blocks: ${types(out)}`)
  } else console.log(`ok    ${name}`)
}
console.log(`\n${cases.length - bad}/${cases.length} bodies round-trip byte-for-byte with identical block structure`)
process.exit(bad ? 1 : 0)
