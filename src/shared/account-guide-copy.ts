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
  API_KEY_DOES: 'Pick the vendor, then paste the key into the Setup terminal below and press Enter. Magpie keeps it; Cookrew never sees it.',
  ENDPOINT: 'Your own endpoint',
  REMOTE: 'Another computer’s Magpie',
  REMOTE_DOES: 'Use the accounts, quota and routing groups of a Magpie on another computer you own.',
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
