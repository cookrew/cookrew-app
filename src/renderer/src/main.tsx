import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './brand-motion.css'
import { authStore } from './auth-gate'
import { startPhoneBeacon } from './phone-beacon'
import { startCompanionPathSwitch } from './path/companion'
import { isRemoteMode } from './api'
import { scheduleWebglWarmup } from './gpu-warmup'

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
startPhoneBeacon()

// A companion on the relay or the tailnet keeps looking for the Mac on the
// nearer network, and moves the session there without asking. A no-op on the
// desktop and on a phone already on the LAN (see path/companion.ts).
startCompanionPathSwitch()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Not on the phone: the first WebGL context in this process costs ~75ms and the
// terminal overlay's renderer will need one on the first zoom-to-card. Take
// that hit at idle, after first paint, instead (gpu-warmup.ts). The phone
// never uses WebGL (see TerminalOverlay), so there is nothing to warm there;
// demo mode in a browser tab also runs it, harmlessly.
if (!isRemoteMode()) scheduleWebglWarmup()
