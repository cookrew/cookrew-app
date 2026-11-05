import type { RemoteAccess } from '../../../shared/remote-access'
import { readySourceList, type UseSource, type UseSourceList } from '../../../shared/use-sources'

/** The demo's windows: no machine stands behind it, so it draws its own. */

const picture = (ground: string, line: string): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="${ground}"/><rect y="0" width="400" height="26" fill="${line}" opacity=".25"/><rect x="24" y="52" width="210" height="10" rx="3" fill="${line}"/><rect x="24" y="76" width="300" height="8" rx="3" fill="${line}" opacity=".6"/><rect x="24" y="96" width="260" height="8" rx="3" fill="${line}" opacity=".6"/><rect x="24" y="116" width="280" height="8" rx="3" fill="${line}" opacity=".6"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const windowRow = (id: number, app: string, title: string, ground: string, line: string): UseSource => ({
  id: `window:${id}`,
  kind: 'window',
  title,
  app,
  address: `window://${encodeURIComponent(app)}?id=${id}`,
  thumb: picture(ground, line),
  icon: null,
  width: 1280,
  height: 800
})

const display = (name: string, title: string): UseSource => ({
  id: `screen:${name}`,
  kind: 'screen',
  title,
  app: null,
  address: `screen://${name}`,
  thumb: picture('#1f2a33', '#cfe3ee'),
  icon: null,
  width: 1728,
  height: 1117
})

export const demoSources = (): UseSourceList =>
  readySourceList({
    windows: [
      windowRow(101, 'Safari', 'Release notes', '#f6f4ef', '#3a3a3a'),
      windowRow(102, 'Terminal', 'npm run build', '#16181d', '#8fd18a'),
      windowRow(103, 'Simulator', 'iPhone 17 Pro', '#e9eef6', '#31577f'),
      windowRow(104, 'Figma', 'Share sheet', '#2c2c31', '#d7d7dc')
    ],
    screens: [display('main', 'Main display'), display('2', 'Display 2')]
  })

/** No machine stands behind the demo: its screen is always ready, and nobody can take it. */
export const demoRemoteAccess = (): RemoteAccess => ({
  state: { id: 'ready', platform: 'darwin', build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }, then: null, detail: null, lastSeenAt: null, until: null, waiting: false },
  control: { available: true, switchOn: false, accessibility: true }
})
