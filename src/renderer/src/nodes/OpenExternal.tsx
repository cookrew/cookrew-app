import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { externalOpenMode } from '../../../shared/external-url'

/**
 * "Open in browser": hand the page to a REAL browser. Two environments, two
 * mechanisms, one deliberate difference:
 *
 * - Electron renderer (bridge has openExternal): shell.openExternal on the
 *   desktop — an <a> inside the app shell would navigate the canvas away.
 * - Phone companion / demo tab (no bridge method): a genuine anchor. On the
 *   phone this IS the deep-link handoff — iOS Universal Links and Android App
 *   Links fire on a real user-gesture https navigation, and routing the click
 *   through JS instead loses the app-open on iOS.
 *
 * Mode selection (incl. why non-web URLs disable rather than hide on the
 * button path) lives in externalOpenMode, where it is unit-tested.
 */
export function OpenExternal({
  url,
  className
}: {
  url: string
  className?: string
}): React.JSX.Element | null {
  const bridged = cookrew().openExternal
  const mode = externalOpenMode(bridged !== undefined, url)
  if (mode === 'hidden') return null
  const cls = `${className ?? ''} nodrag`.trim()
  if (mode === 'anchor') {
    return (
      <a
        className={cls}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        title="Open in browser"
        aria-label="Open in browser"
        onClick={(e) => e.stopPropagation()}
      >
        <CrIcon name="external" />
      </a>
    )
  }
  return (
    <button
      className={cls}
      disabled={mode === 'disabled'}
      title="Open in browser"
      aria-label="Open in browser"
      onClick={(e) => {
        e.stopPropagation()
        // Failure (OS refused, handler rejected) is not actionable here; a
        // rejection crossing IPC unhandled would only spam the console relay.
        void bridged?.(url).catch(() => undefined)
      }}
    >
      <CrIcon name="external" />
    </button>
  )
}
