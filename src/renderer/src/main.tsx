import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { startPhoneBeacon } from './phone-beacon'

// The phone's black box: self-reported vitals every 3 s, because no Apple
// inspection channel survives contact with this device (see phone-beacon.ts).
startPhoneBeacon()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
