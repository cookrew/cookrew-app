import { Fragment, memo } from 'react'
import { parseMarkdown, type BlockNode, type InlineNode, type TableAlign } from './markdown'

/**
 * Render a markdown reply body (unified-scroll addendum) as REACT ELEMENTS ONLY
 * — no dangerouslySetInnerHTML, no raw HTML pass-through. The pure parser
 * (markdown.ts) yields a safe AST; this walks it to STANDARD tags (strong / em /
 * code / pre / ul / ol / h1-6 / p / table), which Fresco styles by tag under
 * `.ctx-block-reply.md` to keep the phosphor terminal aesthetic. Anything the
 * parser didn't recognize already arrived as plain text, so it renders verbatim.
 */
export const MarkdownText = memo(function MarkdownText({
  source
}: {
  source: string
}): React.JSX.Element {
  // memo() over the one string prop (2026-10-04): a reply that has not
  // changed is not parsed again. Transcript rows re-render on every scroll
  // frame of a live card, and this parse was the cost of each.
  return (
    <>
      {parseMarkdown(source).map((block, i) => (
        <Block key={i} node={block} />
      ))}
    </>
  )
})

function Inlines({ nodes }: { nodes: InlineNode[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'strong':
            return (
              <strong key={i}>
                <Inlines nodes={node.children} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={node.children} />
              </em>
            )
          case 'code':
            return <code key={i}>{node.value}</code>
          default:
            return <Fragment key={i}>{node.value}</Fragment>
        }
      })}
    </>
  )
}

function Block({ node }: { node: BlockNode }): React.JSX.Element {
  switch (node.type) {
    case 'heading': {
      const Tag = `h${node.level}` as keyof React.JSX.IntrinsicElements
      return (
        <Tag>
          <Inlines nodes={node.children} />
        </Tag>
      )
    }
    case 'code':
      return (
        <pre>
          <code>{node.value}</code>
        </pre>
      )
    case 'table':
      // Its own box scrolls sideways: a wide table never widens the chat (a phone is 412px).
      return (
        <div className="md-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {node.head.map((cell, k) => (
                  <th key={k} style={alignOf(node.align[k])}>
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, k) => (
                    <td key={k} style={alignOf(node.align[k])}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul'
      return (
        <Tag>
          {node.items.map((item, i) => (
            <li key={i}>
              <Inlines nodes={item} />
            </li>
          ))}
        </Tag>
      )
    }
    default:
      return (
        <p>
          <Inlines nodes={node.children} />
        </p>
      )
  }
}

/** A column's alignment from the separator row's colons; none leaves the stylesheet's. */
const alignOf = (align: TableAlign | undefined): React.CSSProperties | undefined => (align ? { textAlign: align } : undefined)
