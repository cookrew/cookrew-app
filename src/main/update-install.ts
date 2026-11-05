import { execFile } from 'node:child_process'
import type { UpdateInstaller } from './update-check'

/**
 * WHETHER THIS BUILD CAN REPLACE ITSELF, AND THE SEAM ONTO electron-updater.
 *
 * A Mac installs an update only over a build signed with a real identity, so an
 * ad hoc build must not try. The portable Windows exe has no installer to run,
 * and on Linux only an AppImage can swap itself. Everything else stays on the
 * release page (update-check.ts).
 */

export interface InstallFacts {
  readonly platform: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly execPath: string
  /** What `codesign -dvv` says about a bundle. */
  describeSignature(bundle: string): Promise<string>
}

const describeSignature = (bundle: string): Promise<string> =>
  new Promise((resolve, reject) => {
    // codesign writes its description to stderr.
    execFile('/usr/bin/codesign', ['-dvv', bundle], { timeout: 10_000 }, (error, _stdout, stderr) => (error ? reject(error) : resolve(String(stderr))))
  })

async function macSigned(facts: InstallFacts): Promise<boolean> {
  const bundle = /^(.*\.app)\/Contents\/MacOS\//.exec(facts.execPath)?.[1]
  if (!bundle) return false
  const description = await facts.describeSignature(bundle).catch(() => '')
  return /^Authority=/m.test(description)
}

export async function canUpdateItself(facts: InstallFacts): Promise<boolean> {
  if (facts.platform === 'darwin') return macSigned(facts)
  if (facts.platform === 'win32') return facts.env.PORTABLE_EXECUTABLE_DIR === undefined
  return facts.env.APPIMAGE !== undefined
}

/** Loaded only when asked: importing electron-updater reads the packaged app. */
const updater = async (): Promise<typeof import('electron-updater').autoUpdater> => {
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.autoDownload = false
  // A quit the owner chose installs what is ready; it is never a surprise restart.
  autoUpdater.autoInstallOnAppQuit = true
  return autoUpdater
}

export function electronUpdateInstaller(): UpdateInstaller {
  return {
    supported: () => canUpdateItself({ platform: process.platform, env: process.env, execPath: process.execPath, describeSignature }),
    async fetch() {
      const autoUpdater = await updater()
      const found = await autoUpdater.checkForUpdates()
      if (!found?.isUpdateAvailable) return null
      await autoUpdater.downloadUpdate()
      return found.updateInfo.version
    },
    install() {
      void updater().then((autoUpdater) => autoUpdater.quitAndInstall())
    }
  }
}
