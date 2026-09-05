import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { startPhoneBeacon } from './phone-beacon'
import { startCompanionPathSwitch } from './path/companion'

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
