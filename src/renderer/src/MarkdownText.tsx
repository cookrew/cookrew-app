import { Fragment, memo, useLayoutEffect, useRef, useState } from 'react'
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
        <TableBox>
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
        </TableBox>
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

/** Which side of a table's box has more of it off screen: null when it all fits. */
export function tableEdge(box: { readonly scrollLeft: number; readonly clientWidth: number; readonly scrollWidth: number }): 'left' | 'right' | 'both' | null {
  const left = box.scrollLeft > 1
  const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 1
  return left && right ? 'both' : left ? 'left' : right ? 'right' : null
}

/**
 * A table's box: it scrolls sideways only when the columns cannot wrap to fit
 * (transcript-paper.css), and then says so — the outer box fades the cut edge
 * while there is more off that side (UI/UX QA 2026-11-01: on a phone the
 * columns just stopped). Read on scroll and on resize, never per frame.
 */
function TableBox({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState<ReturnType<typeof tableEdge>>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const next = tableEdge(el)
      setEdge((at) => (at === next ? at : next))
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', read)
      ro?.disconnect()
    }
  }, [])
  return (
    <div className="md-table-box" data-more={edge ?? undefined}>
      <div ref={ref} className="md-table" role="region" aria-label="Table" tabIndex={0}>
        {children}
      </div>
    </div>
  )
}
