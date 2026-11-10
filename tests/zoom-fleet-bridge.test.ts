// THE ZOOM NAVIGATOR'S DEVICES, wired end to end: the desktop window reads its
// own fleet service over zoom-fleet:* IPC (the old levels:* view stays gone,
// see levels-removed.test.ts), the phone reads the companion's /api/fleet
// stream, and both list the account's desktops. Every member is optional on
// CookrewApi: the demo has neither, and the hook falls back by feature.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('the zoom fleet bridge', () => {
  it('is optional on the API, so every surface feature-detects it', () => {
    const api = read('src/renderer/src/api.ts')
    expect(api).toMatch(/subscribeZoomFleet\?: \(/)
    expect(api).toMatch(/zoomFleetMachines\?: \(\) => Promise<AccountMachines>/)
  })

  it('reaches main over its own channels on the desktop', () => {
    const preload = read('src/preload/index.ts')
    for (const channel of ['zoom-fleet:event', 'zoom-fleet:subscribe', 'zoom-fleet:unsubscribe', 'zoom-fleet:machines']) {
      expect(preload, channel).toContain(`'${channel}'`)
    }
    const main = read('src/main/index.ts')
    expect(main).toMatch(/registerZoomFleetIpc\(ipcMain\.handle\.bind\(ipcMain\)/)
    expect(main).toMatch(/service: localFleetService/)
    expect(read('src/main/mobile-server.ts')).toMatch(/export function localFleetService\(\): FleetService \| null/)
  })

  it('reads the companion’s fleet stream with the pairing token, on a stream that heals', () => {
    const remote = read('src/renderer/src/remote-api.ts')
    expect(remote).toContain("openEventSource(apiPath('/api/fleet/stream'))")
    // A feed that dies without a reset is reopened, and moves with the plane.
    expect(remote).toMatch(/new ReconnectingStream\(\{[\s\S]{0,400}\/api\/fleet\/stream/)
    expect(remote).toMatch(/registerPlaneStream\(\{ restart: \(\) => stream\.restart\(\), revive: \(\) => stream\.revive\(\) \}\)/)
    // The account's machines come from the registry, by the scope's relay access (machine-scope.ts).
    expect(remote).toMatch(/zoomFleetMachines: \(\) => relayAccountMachines\(machineScope\(\)\)/)
  })
})
