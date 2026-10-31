import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type InlineNode } from '../src/renderer/src/markdown'

describe('parseInline (bold / italics / inline code)', () => {
  it('keeps plain text as a single node', () => {
    expect(parseInline('just text')).toEqual([{ type: 'text', value: 'just text' }])
  })

  it('parses **bold** and __bold__', () => {
    expect(parseInline('a **b** c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' c' }
    ])
    expect(parseInline('__b__')).toEqual([
      { type: 'strong', children: [{ type: 'text', value: 'b' }] }
    ])
  })

  it('parses *italic* and _italic_', () => {
    expect(parseInline('*i*')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'i' }] }])
    expect(parseInline('_i_')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'i' }] }])
  })

  it('parses inline `code` literally (no nested formatting)', () => {
    expect(parseInline('run `a **b**` now')).toEqual([
      { type: 'text', value: 'run ' },
      { type: 'code', value: 'a **b**' },
      { type: 'text', value: ' now' }
    ])
  })

  it('nests emphasis inside strong', () => {
    expect(parseInline('**bold _and italic_**')).toEqual([
      {
        type: 'strong',
        children: [
          { type: 'text', value: 'bold ' },
          { type: 'em', children: [{ type: 'text', value: 'and italic' }] }
        ]
      }
    ])
  })

  it('leaves snake_case underscores as literal text', () => {
    expect(parseInline('call some_long_name here')).toEqual([
      { type: 'text', value: 'call some_long_name here' }
    ])
  })

  it('treats an unmatched delimiter as plain text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', value: '2 * 3 = 6' }])
    expect(parseInline('a `dangling')).toEqual([{ type: 'text', value: 'a `dangling' }])
  })
})

describe('parseMarkdown (blocks)', () => {
  it('wraps a line in a paragraph', () => {
    expect(parseMarkdown('hello world')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'hello world' }] }
    ])
  })

  it('splits paragraphs on a blank line and joins soft-wrapped lines', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree')
    expect(blocks).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'one two' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'three' }] }
    ])
  })

  it('parses ATX headings with inline content', () => {
    expect(parseMarkdown('## A **title**')).toEqual([
      {
        type: 'heading',
        level: 2,
        children: [
          { type: 'text', value: 'A ' },
          { type: 'strong', children: [{ type: 'text', value: 'title' }] }
        ]
      }
    ])
  })

  it('parses an unordered list', () => {
    expect(parseMarkdown('- one\n- two')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', value: 'one' }], [{ type: 'text', value: 'two' }]]
      }
    ])
  })

  it('parses an ordered list', () => {
    expect(parseMarkdown('1. a\n2. b')).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', value: 'a' }], [{ type: 'text', value: 'b' }]]
      }
    ])
  })

  it('does not treat *emphasis* at line start as a bullet (needs a space)', () => {
    expect(parseMarkdown('*emph* text')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'em', children: [{ type: 'text', value: 'emph' }] },
          { type: 'text', value: ' text' }
        ]
      }
    ])
  })

  it('parses a fenced code block with a language, verbatim', () => {
    const src = '```ts\nconst a = 1 // **not bold**\n```'
    expect(parseMarkdown(src)).toEqual([
      { type: 'code', lang: 'ts', value: 'const a = 1 // **not bold**' }
    ])
  })

  it('keeps an unclosed fence as a code block to EOF', () => {
    expect(parseMarkdown('```\nx\ny')).toEqual([{ type: 'code', lang: null, value: 'x\ny' }])
  })

  it('handles CRLF line endings', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'a' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'b' }] }
    ])
  })
})

// UI/UX QA (Gauge, 2026-11-01): agents write GitHub tables often, and CHAT
// showed them as one paragraph of pipes ("| Entry point | Before | Now |
// |---|---|---| | cookrew ask | ..."). A well-formed table is a table now;
// anything else stays text, as before.
describe('parseMarkdown (GitHub tables)', () => {
  const t = (...lines: string[]): string => lines.join('\n')
  const text = (value: string): InlineNode[] => [{ type: 'text', value }]

  it('a header row, the separator and body rows make a table', () => {
    expect(parseMarkdown(t('| Entry point | Before | Now |', '|---|---|---|', '| cookrew ask | already resumed it | wakes it |'))).toEqual([
      {
        type: 'table',
        align: [null, null, null],
        head: [text('Entry point'), text('Before'), text('Now')],
        rows: [[text('cookrew ask'), text('already resumed it'), text('wakes it')]]
      }
    ])
  })

  it('cells take inline code and bold', () => {
    const [table] = parseMarkdown(t('| a | b |', '| --- | --- |', '| `x --y` | **yes** |'))
    expect(table).toMatchObject({
      type: 'table',
      rows: [[[{ type: 'code', value: 'x --y' }], [{ type: 'strong', children: text('yes') }]]]
    })
  })

  it('a pipe inside inline code, or escaped, stays in its cell', () => {
    const [table] = parseMarkdown(t('| cmd | note |', '|---|---|', '| `a | b` | x \\| y |'))
    expect(table).toMatchObject({ rows: [[[{ type: 'code', value: 'a | b' }], text('x | y')]] })
  })

  it('reads the alignment colons, and outer pipes are optional', () => {
    const [table] = parseMarkdown(t('a | b | c', ':--- | :---: | ---:', '1 | 2 | 3'))
    expect(table).toMatchObject({ type: 'table', align: ['left', 'center', 'right'] })
  })

  it('a short row is padded with empty cells, a long one cut to the header', () => {
    const [table] = parseMarkdown(t('| a | b |', '|---|---|', '| 1 |', '| 1 | 2 | 3 |', '| PASS | |'))
    expect(table).toMatchObject({ rows: [[text('1'), []], [text('1'), text('2')], [text('PASS'), []]] })
  })

  it('ends at the first line that is not a row, and may follow a paragraph line directly', () => {
    expect(parseMarkdown(t('Here is the matrix:', '| a | b |', '|---|---|', '| 1 | 2 |', 'And after it.')).map((b) => b.type)).toEqual([
      'paragraph',
      'table',
      'paragraph'
    ])
  })

  it('a header with no separator, or a separator of the wrong width, stays plain text', () => {
    expect(parseMarkdown(t('| a | b |', '| 1 | 2 |')).map((b) => b.type)).toEqual(['paragraph'])
    expect(parseMarkdown(t('| a | b | c |', '|---|---|', '| 1 | 2 | 3 |')).map((b) => b.type)).toEqual(['paragraph'])
    expect(parseMarkdown('a | b')).toEqual([{ type: 'paragraph', children: text('a | b') }])
  })

  it('a table inside a fenced code block is code', () => {
    expect(parseMarkdown(t('```', '| a | b |', '|---|---|', '```')).map((b) => b.type)).toEqual(['code'])
  })
})
