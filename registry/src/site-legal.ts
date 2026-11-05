import { breadcrumbs, organization, webPage } from './site-seo'
import { esc, page, type Page } from './site-shell'
import { PRIVACY, TERMS, type LegalBlock, type LegalDoc, type LegalSection } from './site-legal-content'

/**
 * /privacy AND /terms — two documents, one shape.
 *
 * Documents in the shell's sense too: no script and nothing to act on, so a
 * reviewer following the link from a consent screen sees the same bytes as
 * anybody else, signed in or not. The words live in site-legal-content.ts.
 */

const PLACEHOLDER = /\[[A-Z ]+\]/g

/** Escaped text, with any unfilled placeholder marked so it cannot pass for a finished sentence. */
const inline = (text: string): string => esc(text).replace(PLACEHOLDER, (found) => `<mark class="ph">${found}</mark>`)

function tableHtml(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const headRow = head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('')
  const bodyRows = rows
    .map(([first, ...rest]) => {
      const cells = rest.map((cell, at) => `<td data-label="${esc(head[at + 1])}">${inline(cell)}</td>`).join('')
      return `<tr><th scope="row">${inline(first)}</th>${cells}</tr>`
    })
    .join('')
  return `<div class="legal-table"><table class="cmp"><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
}

function blockHtml(block: LegalBlock): string {
  if ('p' in block) return `<p>${inline(block.p)}</p>`
  if ('ul' in block) return `<ul>${block.ul.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`
  return tableHtml(block.table.head, block.table.rows)
}

function sectionHtml(section: LegalSection): string {
  const chip = section.planned ? '<span class="chip legal-chip">Planned, not live</span>' : ''
  const open = section.planned ? `<section class="legal-planned" id="${esc(section.id)}">` : `<section id="${esc(section.id)}">`
  return `${open}${chip}<h2>${inline(section.heading)}</h2>${section.blocks.map(blockHtml).join('')}</section>`
}

/** The article, without the shell: heading, contents list, sections. */
export function legalBody(doc: LegalDoc): string {
  const contents = doc.sections.map((s) => `<li><a href="#${esc(s.id)}">${inline(s.heading)}</a></li>`).join('')
  return `<article class="legal">
<h1>${inline(doc.title)}</h1>
<p class="lede">${inline(doc.lede)}</p>
<p class="meta">Last updated <time datetime="${esc(doc.updated)}">${esc(doc.updated)}</time></p>
<nav class="legal-toc" aria-label="On this page"><ol>${contents}</ol></nav>
${doc.sections.map(sectionHtml).join('\n')}
</article>`
}

function legalPage(doc: LegalDoc, path: string, description: string, other: { href: string; label: string }): Page {
  return page(
    {
      title: `${doc.title} · Cookrew`,
      kind: 'document',
      description,
      path,
      jsonLd: [
        organization(),
        webPage({ path, name: doc.title, description }),
        breadcrumbs([
          { name: 'Cookrew', path: '/' },
          { name: doc.title, path }
        ])
      ]
    },
    `<div class="wrap" style="padding-top:36px;padding-bottom:44px">
<p class="meta"><a href="/">Cookrew</a> / ${esc(doc.title)}</p>
${legalBody(doc)}
<p class="meta">See also: <a href="${esc(other.href)}">${esc(other.label)}</a></p>
</div>`
  )
}

export const privacyPage = (): Page =>
  legalPage(PRIVACY, '/privacy', 'What cookrew.dev stores, what it never stores, what passes through its relay, and for how long.', {
    href: '/terms',
    label: 'Terms of service'
  })

export const termsPage = (): Page =>
  legalPage(TERMS, '/terms', 'The terms for using cookrew.dev, its marketplace of served agent teams, and its relay.', {
    href: '/privacy',
    label: 'Privacy policy'
  })
