import { Fragment } from 'react'
import { parseMarkdown, type BlockNode, type InlineNode } from './markdown'

/**
 * Render a markdown reply body (unified-scroll addendum) as REACT ELEMENTS ONLY
 * — no dangerouslySetInnerHTML, no raw HTML pass-through. The pure parser
 * (markdown.ts) yields a safe AST; this walks it to STANDARD tags (strong / em /
 * code / pre / ul / ol / h1-6 / p), which Fresco styles by tag under
 * `.ctx-block-reply.md` to keep the phosphor terminal aesthetic. Anything the
 * parser didn't recognize already arrived as plain text, so it renders verbatim.
 */
export function MarkdownText({ source }: { source: string }): React.JSX.Element {
  return (
    <>
      {parseMarkdown(source).map((block, i) => (
        <Block key={i} node={block} />
      ))}
    </>
  )
}

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
