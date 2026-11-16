import type { AccountVia } from './ai-account'

/** The AI account guide: the first run's tool check, the Routing panel and the launch nudge (shared/ai-account.ts). */
export const ACCOUNT_COPY = {
  HEAD: 'Connect an AI account',
  LEDE: 'Agents need an AI account to run on. Pick any way below; you can add more later under Routing.',
  READY: (via: AccountVia): string =>
    ({
      claude: 'Ready: Claude Code is signed in.',
      codex: 'Ready: Codex is signed in.',
      endpoint: 'Ready: agents run on your own endpoint.',
      magpie: 'Ready: new agents go through Magpie.'
    })[via],
  SUBSCRIPTION: 'Claude or ChatGPT subscription',
  SUBSCRIPTION_DOES: 'Sign in with the plan you already pay for. A browser page opens; come back here when it says you are signed in.',
  SUBSCRIPTION_NONE: 'Install Claude Code or Codex above first, or install Magpie.',
  API_KEY: 'API key',
  API_KEY_DOES: 'In Magpie’s settings choose Providers › Add, pick the vendor and paste its key there. Magpie keeps it; it never passes through a terminal or Cookrew.',
  ENDPOINT: 'Your own endpoint',
  REMOTE: 'Another computer’s Magpie',
  REMOTE_DOES: 'Use the accounts, quota and routing groups of a Magpie on another computer you own. In Magpie’s settings choose Providers › Add › Remote magpie and type its address and key there: the key never passes through a terminal.',
  REMOTE_OPEN: 'Open Magpie settings',
  NEEDS_MAGPIE: 'Needs Magpie on this computer.',
  INSTALL_MAGPIE: 'Install Magpie',
  MAGPIE_STOPPED: 'Magpie is installed but not running.',
  START_MAGPIE: 'Start Magpie',
  OPEN: 'Set up',
  CLOSE: 'Close',
  DEFAULT_HEAD: 'One step left: the model new agents use',
  DEFAULT_DOES: 'Magpie has models now. Pick the one new agents go to; a routing group follows the quota for you.',
  DEFAULT_PICK: 'Choose a model',
  NUDGE: 'No AI account yet, so agents have nothing to run on.',
  NUDGE_GO: 'Set one up',
  NUDGE_LATER: 'Not now'
} as const

export const REMOTE_COPY = {
  ADDRESS: 'Address',
  ADDRESS_HINT: '192.168.1.20 or mac.tailnet.ts.net',
  ADDRESS_WHERE: 'On the other computer, Routing › Share with my devices shows its address and makes the key.',
  NAME: 'Name',
  NAME_HINT: 'office',
  NAME_NOTE: 'Its models show up as name/model, such as office/claude-opus.',
  CONNECT: 'Connect',
  CANCEL: 'Cancel',
  PASTE: 'Now paste the key into the Setup terminal right after key= and press Enter.'
} as const

export const SHARE_COPY = {
  HEAD: 'Share with my devices',
  LEDE: 'Let your other computers use this Magpie: its accounts, quota and routing groups. Each device gets its own key with a daily cap.',
  OFF_NETWORK: 'Magpie here answers only this computer. In Magpie, open Settings › Gateway and share it on the network, then check again.',
  CHECK: 'Check again',
  ADDRESSES: 'Other devices reach it at',
  NO_ADDRESS: 'No LAN or tailnet address found on this computer.',
  PLAIN: 'These are plain http: the key and every request cross the network unencrypted. A tailnet address (100.x) is encrypted underneath; use a LAN address only on a network you trust, never a café’s or a hotel’s. For anything else turn on https in Magpie first.',
  LOOPBACK_HEAD: 'A Remote magpie on this computer’s loopback',
  LOOPBACK: (id: string, port: number): string => `“${id}” is reached at 127.0.0.1:${port}, a tunnel. While the tunnel is down, any program that takes that port is handed its key and every request. Take it out, and connect that computer by its own address in Magpie’s settings.`,
  LOOPBACK_REMOVE: (id: string): string => `Take out ${id}`,
  DEVICE: 'Device name',
  DEVICE_HINT: 'laptop',
  DAILY: 'Daily cap (USD)',
  ISSUE: 'Make a key',
  ISSUING: 'Making…',
  KEY_ONCE: 'Copy this key now: it is shown once. On the other computer, open Routing › Add › Another computer’s Magpie.',
  COPY: 'Copy key',
  COPIED: 'Copied',
  DONE: 'Done',
  REVOKE: 'Revoke',
  NONE: 'No device has a key yet.',
  UNAVAILABLE: 'Sharing needs Magpie on this computer.'
} as const

/** The two Magpie switches: Launch settings and the first-run guide alike (routing/MagpieSwitches.tsx). */
export const MAGPIE_SWITCH_COPY = {
  HEAD: 'Magpie',
  USE: 'Use Magpie',
  USE_NOTE: 'Route agents’ models through Magpie: one place for every subscription, API key and routing group. Off: every agent runs on its own sign-in, and Cookrew shows no Magpie way in.',
  REMOTE: 'Use another computer’s Magpie (Magpie remote)',
  REMOTE_NOTE: 'Connect a Magpie running on another computer you own and use its accounts, or share this one with your devices, each with its own key and daily cap.',
  REMOTE_NEEDS: 'Turn on Magpie first.',
  PINNED: (name: string): string => `Set by ${name} when Cookrew started.`,
  CONFIGURE: 'Open Magpie settings',
  CONFIGURING: 'Opening…',
  CONFIGURE_NOTE: 'Magpie’s own settings page opens in a browser card here: accounts, keys, routing groups and Remote magpie.',
  NOT_INSTALLED: 'Magpie is not installed yet.',
  LIVE: 'Applies at once: the next agent and this screen follow it.'
} as const
