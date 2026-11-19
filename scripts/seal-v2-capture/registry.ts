// The registry, unmodified, in a process of its own for the seal capture
// (scripts/seal-v2-capture/run.ts). Configured as the registry's own tests
// configure it (the legacy second step, generous sign-up limits), because a
// headless run cannot take the real second step. Nothing on the relay path
// differs from production: same server, same canvas relay, same limits.
//
//   vite-node scripts/seal-v2-capture/registry.ts <port> <data dir>
import { DoorStore } from '../../registry/src/doors'
import { IdentityService } from '../../registry/src/identity'
import { TransparencyLog } from '../../registry/src/log'
import { createRegistry } from '../../registry/src/server'
import { StarStore } from '../../registry/src/stars'
import { RegistryStore } from '../../registry/src/store'
import { createV2 } from '../../registry/src/v2-routes'

const [port, dir] = process.argv.slice(2)
if (!port || !dir) throw new Error('usage: registry.ts <port> <data dir>')
const server = createRegistry({
  store: new RegistryStore(dir),
  log: new TransparencyLog(dir),
  identity: new IdentityService(dir),
  doors: new DoorStore(dir, { allowPrivate: true }),
  stars: new StarStore(dir),
  origin: 'https://cookrew.dev',
  v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
})
server.listen(Number(port), '127.0.0.1', () => console.log(`registry listening on ${port} (pid ${process.pid})`))
