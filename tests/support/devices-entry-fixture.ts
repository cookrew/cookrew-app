import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'

// The real account surface and the real Launch settings sheet, with their real
// sheet styles. Only the Electron bridge is a fixture: no account, key or
// registry is ever reached, and minting a code is recorded instead of sent.
const ENTRY = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAccountSurface } from './src/renderer/src/account/AccountSurface'
import { LaunchSettingsSheet } from './src/renderer/src/LaunchSettingsSheet'

const values = { registry:'http://127.0.0.1',interactiveBrowser:true,multiInstance:true,multiplexer:'direct',magpie:true,magpieRemote:true }
const status = { username:'fixture', displayName:'',avatar:null,locked:false,lockAfterMs:900000,requests:0,envUsername:null,legacy:null,sessionExpired:false,passwordPending:false,passwordless:false,unlockBy:'password',lockWaits:null,fromTerminal:false,touchId:{available:false,on:false},registryMismatch:null,signInAgainBecause:null,workspacesReachable:true,recoveryCodesSavedAt:null,recoveryCodesLeft:null }
window.fixtureCalls = []
window.cookrew = {
  accountClaim: async () => ({}),
  accountStatus: async () => status,
  accountProfile: async () => ({ ok:true, value:{devices:[]} }),
  accountAdmittedDevices: async () => [],
  accountJoinCode: async () => { window.fixtureCalls.push('mint'); return {ok:false, reason:'fixture'} },
  listWorkspaces: async () => ({workspaces:[]}),
  launchSettings: async () => ({ values, running: values, pinned: [], restart: false, signedIn: true }),
  launchLive: async () => ({values:{magpie:true,magpieRemote:true},pinned:[]}),
  magpieRemoteList: async () => ({signedIn:true,forwarder:3428,sealed:true,problem:null,desktopsKnown:true,desktops:[]})
}
function Fixture() {
  const account = useAccountSurface()
  const [launch, setLaunch] = useState(false)
  return <>
    <button onClick={() => setLaunch(true)}>Open launch settings</button>
    {account.avatar}
    {launch && <LaunchSettingsSheet onClose={() => setLaunch(false)} />}
    {account.overlays}
  </>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

export async function startDevicesEntryFixture() {
  const bundle = await build({
    stdin: { contents: ENTRY, loader: 'tsx', resolveDir: process.cwd() },
    outdir: 'fixture', entryNames: 'fixture', bundle: true, write: false, platform: 'browser', jsx: 'automatic'
  })
  const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))
  if (!js || !css) throw new Error('Devices-entry fixture did not produce its bundle and styles')
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/fixture.css"><main id="root"></main><script src="/fixture.js"></script>`
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/fixture.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(js.contents)
    else if (url.pathname === '/fixture.css') response.writeHead(200, { 'content-type': 'text/css' }).end(css.contents)
    else if (url.pathname === '/') response.writeHead(200, { 'content-type': 'text/html' }).end(html)
    else response.writeHead(204).end()
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
