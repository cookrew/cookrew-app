import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import './night.css'
import './zoom/ink-theme.css'
// Last: the phone's one sheet of type sizes (it outranks the sheets above by its selectors, not its place).
import './phone-type.css'
import { authStore } from './auth-gate'
import { startPhoneBeacon } from './phone-beacon'
import { startCompanionPathSwitch } from './path/companion'
import { cookrew, isRemoteMode } from './api'
import { watchBuild } from './build-watch'
import { reloadForNewBuildNow } from './crash-report'
import { scheduleWebglWarmup } from './gpu-warmup'
import { bootEmbedMode } from './embed/embed-mode'
import { applyColorScheme } from './color-scheme'
import { watchUserInput } from './user-input'

// STRATA EMBED MODE (`?embed=agent`, framed by cookrew.dev's shell only): one
// agent's full view, nothing else. Read before anything starts, because embed
// mode skips the phone's beacon, the build-watch reload and — the one that
// matters — the path switch, which would move this document's data plane to a
// LAN origin or an RTC link and break the shell's same-origin frame.
const embed = bootEmbedMode()

// Light or dark before the first paint: a browser follows the system, the
// desktop app stays paper (color-scheme.ts).
applyColorScheme(isRemoteMode())
// The ink theme before the first paint: a passive effect in App would flash the
// old tokens for a frame on every boot.
document.body.classList.add('cr-ink')
const EmbedRoot = lazy(() => import('./embed/EmbedRoot'))
// THE CANVAS APP IS A CHUNK OF ITS OWN, so an embed never downloads it (it was
// most of the 1.7 MB index). The classic boot asks for it on this very line,
// before anything below runs, so its fetch overlaps the rest of the boot.
const appModule = embed ? null : import('./App')
const App = lazy(() => appModule ?? import('./App'))

// PAIRING, FIRST — before anything on this page can make a request.
//
// The Mac's printed link carries the credential in a fragment
// (`…/#pair=<token>`), and creating the store is what reads it, stores it
// against THIS desktop and takes it back off the URL. Everything below either
// makes an authenticated request or renders a screen that will; ordering this
// by accident would mean one unauthenticated 401 on a freshly scanned QR and a
// token that lingered in the address bar until something happened to ask for
// it. Stated here rather than left to module import order.
authStore()

// The phone's black box: self-reported vitals every 3 s, because no Apple
// inspection channel survives contact with this device (see phone-beacon.ts).
if (!embed) startPhoneBeacon()

// A companion on the relay or the tailnet keeps looking for the Mac on the
// nearer network, and moves the session there without asking. A no-op on the
// desktop and on a phone already on the LAN (see path/companion.ts).
if (!embed) startCompanionPathSwitch()

// A resident Home Screen app reloads itself when the Mac serves another
// build, at the next switch away or back — never under a finger (build-watch.ts).
const onBuild = isRemoteMode() && !embed ? cookrew().onBuild : undefined
if (onBuild) {
  watchBuild({
    onBuild,
    reload: () => window.location.reload(),
    onVisibility: (cb) => {
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    }
  })
}

// Before anything can be clicked: a terminal opened by a click takes its pane's size (pane-size.ts · openedAt).
watchUserInput()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {embed ? (
      <Suspense fallback={null}>
        <EmbedRoot mode={embed} />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    )}
  </React.StrictMode>
)

// Not on the phone: the first WebGL context in this process costs ~75ms and the
// terminal overlay's renderer will need one on the first zoom-to-card. Take
// that hit at idle, after first paint, instead (gpu-warmup.ts). The phone
// never uses WebGL (see TerminalOverlay), so there is nothing to warm there;
// demo mode in a browser tab also runs it, harmlessly.
if (!isRemoteMode()) scheduleWebglWarmup()

// A chunk of an older build failed to load (Vite reports it here before the
// import rejects): the Mac has rebuilt since this page loaded. Load the new
// build once, before any crash screen (crash-report.ts · reloadForNewBuild).
window.addEventListener('vite:preloadError', () => {
  reloadForNewBuildNow()
})

