import { hostPlatform } from '../../../shared/machine-words'
import { cookrew } from '../api'
import { useRemoteHost } from './remote-acts'
import { RemoteHostBannerView } from './RemotePanel'

/** The banner while someone is on this machine (the menu bar has its own, main/remote-tray.ts). */
export function RemoteHostBanner(): React.JSX.Element | null {
  const view = useRemoteHost()
  if (!view) return null
  return <RemoteHostBannerView view={view} platform={hostPlatform()} onStop={() => void cookrew().stopRemote?.()} />
}
