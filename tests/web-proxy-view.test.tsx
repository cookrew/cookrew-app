import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProxyView } from '../src/renderer/src/mirror/ProxyView'
import { proxyDocument, proxyTargetOf, type ReadProxyAsset } from '../src/renderer/src/mirror/proxy-document'
import { proxyPath } from '../src/shared/web-proxy'
import { PROXY_FRAME_SCRIPT } from '../src/shared/web-proxy-frame.mjs'

const source = (file: string): string => readFileSync(`${__dirname}/../src/renderer/src/${file}`, 'utf8')

describe('remote browser Page', () => {
  it('uses the exact iframe sandbox and exposes Reload and Screen', () => {
    const markup = renderToStaticMarkup(<ProxyView browserId="card-1" cardUrl="https://example.com/" onScreen={() => undefined} />)
    expect(markup).toContain('sandbox="allow-scripts allow-forms allow-popups"')
    expect(markup).toContain('>Reload</button>')
    expect(markup).toContain('>Screen</button>')
    expect(markup).not.toContain('allow-same-origin')
  })

  it('packages CSS and media through the parent and marks active content for Screen', async () => {
    const card = 'card-1'
    const url = 'https://shop.example/page'
    const style = proxyPath(card, 'https://shop.example/styles/site.css')
    const image = proxyPath(card, 'https://cdn.example.net/photo.png')
    const reads: Parameters<ReadProxyAsset>[] = []
    const read: ReadProxyAsset = async (...args) => {
      reads.push(args)
      return args[0] === style
        ? new Response(`p{background:url("${image}")}`, { headers: { 'content-type': 'text/css' } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    }
    const page = await proxyDocument(`<link rel="stylesheet" href="${style}"><script type="module" src="app.js"></script><noscript><p>Page text</p></noscript>`, url, card, 'test-nonce', read)
    expect(page.html).toContain('background:url("data:image/png;base64,AQID")')
    expect(page.html).toContain('<p>Page text</p>')
    expect(page.html).toContain(`data-cookrew-needs-screen=""`)
    expect(page.html).toContain(`<script>${PROXY_FRAME_SCRIPT}</script>`)
    expect(page.html).not.toContain('app.js')
    expect(reads).toEqual([
      [style, 'GET', { origin: 'https://shop.example', omitCookies: false, frameFormat: true }],
      [image, 'GET', { origin: 'https://cdn.example.net', omitCookies: true, frameFormat: true }]
    ])
    expect(proxyTargetOf(proxyPath('other-card', url), card)).toBeNull()
  })

  it('keeps page content in the sandbox and switches to Screen only from a button', () => {
    const view = source('mirror/ProxyView.tsx')
    const remote = source('mirror/RemoteBrowserView.tsx')
    expect(view + remote).not.toMatch(/innerHTML|dangerouslySetInnerHTML|allow-same-origin/)
    expect(view).toContain('onClick={onScreen}')
    expect(view.match(/\bonScreen\b/g)).toHaveLength(3)
    expect(remote.match(/choose\('screen'\)/g)).toHaveLength(1)
    expect(remote).toContain("onClick={() => choose('page')}")
    expect(source('BrowserLayer.tsx')).toMatch(/client === 'remote' && isWebProxyUrl\(tab\.url\)/)
  })
})
