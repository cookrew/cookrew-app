export interface RendererDevResource {
  body: Buffer
  contentType: string
}

/** Only Vite's index/module graph may cross this dev-only proxy. */
export function rendererDevPathAllowed(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/node_modules/')
  )
}

/** Resolve a companion request against the fixed local Vite origin. */
export function rendererDevTarget(
  rendererDevUrl: string,
  pathname: string,
  search = ''
): URL | null {
  try {
    const target = new URL(rendererDevUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
    target.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`
    target.search = search
    target.hash = ''
    return target
  } catch {
    return null
  }
}

/**
 * Fetch one transformed renderer resource from electron-vite's local dev
 * server. The phone still talks only to the companion origin; this hop stays
 * inside the Electron main process.
 */
export async function fetchRendererDevResource(
  rendererDevUrl: string,
  pathname: string,
  search = ''
): Promise<RendererDevResource | null> {
  if (!rendererDevPathAllowed(pathname)) return null
  const target = rendererDevTarget(rendererDevUrl, pathname, search)
  if (!target) return null
  try {
    const upstream = await fetch(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(3000)
    })
    if (!upstream.ok) return null
    return {
      body: Buffer.from(await upstream.arrayBuffer()),
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream'
    }
  } catch {
    return null
  }
}
