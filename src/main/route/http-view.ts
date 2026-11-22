import { ROUTE_HTTP_SCHEMA_VERSION, type HarnessRow, type RouteState } from '../../shared/route'
import { GATE_UNREAD } from './remote-gate'
import { MAGPIE_SWITCHED_OFF } from './service'
import { ADD_KEY_STEM, HARNESS_FACTS, setupLines } from './setup'

// The address-free shape the existing renderer reads. Provider text cannot be
// released without provenance tying every cached value to configuration.
interface RestrictedRouteState extends Pick<RouteState,
  'status' | 'why' | 'switchedOff' | 'defaultModel' | 'providers' | 'checkedAt' | 'autoGroup' | 'sharedMcp' | 'mcpServers' | 'models' | 'quotas' | 'live'> {
  gateway: null
  gatewaySource?: RouteState['gatewaySource']
  remoteRisks?: RouteState['remoteRisks']
  withheld: NonNullable<RouteState['withheld']>
  harnesses: HarnessRow[]
  setup: RouteState['setup']
}

const PLAIN_RISK = 'A Remote Magpie connection uses plain HTTP off a tailnet. Its key and requests cross the network unencrypted. Use a tailnet address or HTTPS in Magpie settings on the host computer.'
const LOOPBACK_RISK = 'A Remote Magpie connection uses a local tunnel. If the tunnel stops, another program can receive its key and requests. Review the connection in Magpie settings on the host computer.'
const staticSetup = setupLines('')
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

function harnessView(row: HarnessRow): HarnessRow[] {
  const facts = HARNESS_FACTS.find(({ id }) => row.id === id)
  return facts ? [{
    id: facts.id,
    name: facts.name,
    installed: row.installed === true,
    signedIn: typeof row.signedIn === 'boolean' ? row.signedIn : null,
    inDock: row.inDock === true,
    installLine: facts.installLine,
    loginLine: facts.loginLine,
    routable: row.routable === true
  }] : []
}

function setupView(setup: RouteState['setup']): RouteState['setup'] {
  return {
    installLine: staticSetup.installLine,
    installAsksAdmin: setup.installAsksAdmin === true,
    serveLine: staticSetup.serveLine,
    pluginLine: '',
    addSubscriptionLine: staticSetup.addSubscriptionLine,
    addKeyLine: ADD_KEY_STEM,
    addLocalLine: staticSetup.addLocalLine,
    addGroupLine: null,
    ...(setup.addAutoGroupLine === undefined ? {} : { addAutoGroupLine: null })
  }
}

function restrictedWhy(state: RouteState): string | null {
  if (state.switchedOff) return state.why === GATE_UNREAD ? GATE_UNREAD : MAGPIE_SWITCHED_OFF
  return state.why ? 'Check Magpie configuration on the host computer.' : null
}

function restrictedRouteState(state: RouteState, inventory: readonly string[] | null): RestrictedRouteState {
  const plain = Boolean(state.plainRemotes?.length)
  const loopback = Boolean(state.loopbackRemotes?.length)
  const source = state.gateway?.source
  return {
    status: state.status,
    gateway: null,
    ...(source === 'plugin' || source === 'probe' ? { gatewaySource: source } : {}),
    ...(plain || loopback ? { remoteRisks: { ...(plain ? { plain: PLAIN_RISK } : {}), ...(loopback ? { loopback: LOOPBACK_RISK } : {}) } } : {}),
    withheld: {
      providerData: true,
      ...(state.defaultModel !== null ? { defaultModel: true } : {}),
      ...(state.setup.addGroupLine != null ? { addGroupLine: true } : {}),
      ...(state.setup.addAutoGroupLine != null ? { addAutoGroupLine: true } : {}),
      ...(state.mcpServers != null && state.mcpServers.length > 0 ? { mcpServers: true } : {}),
      ...(inventory === null ? { endpointInventory: true } : {})
    },
    why: restrictedWhy(state),
    ...(state.switchedOff === undefined ? {} : { switchedOff: state.switchedOff === true }),
    defaultModel: null,
    providers: number(state.providers) ?? 0,
    models: [],
    quotas: [],
    live: [],
    harnesses: state.harnesses.flatMap(harnessView),
    checkedAt: number(state.checkedAt) ?? 0,
    autoGroup: state.autoGroup === true,
    sharedMcp: state.sharedMcp === true,
    mcpServers: state.mcpServers == null ? state.mcpServers : [],
    setup: setupView(state.setup)
  }
}

export function routeHttpView(state: RouteState, sealedOwner: boolean, endpointInventory?: () => string[] | null): RouteState {
  if (sealedOwner) return { ...state, schemaVersion: ROUTE_HTTP_SCHEMA_VERSION }
  let inventory: string[] | null = null
  try {
    inventory = endpointInventory?.() ?? null
  } catch {
    // An unreadable configuration is not evidence of an empty inventory.
  }
  return { ...restrictedRouteState(state, inventory), schemaVersion: ROUTE_HTTP_SCHEMA_VERSION }
}
