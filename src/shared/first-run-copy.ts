/**
 * EVERY WORD A NEW PERSON READS IN THE FIRST RUN, in one place so one test can
 * hold them all to the same rule: no word of ours. A tool is named with what
 * it does for them, and a screen says what happens next, never how Cookrew is
 * built (tests/first-run-copy.test.ts).
 */

export const PREFLIGHT_COPY = {
  TITLE: 'Let’s check this computer',
  LEDE: 'Cookrew runs AI agents that do real work in your folders. Here is what it found.',
  FOUND: 'Found',
  MISSING: 'Not found',
  UNKNOWN: 'Could not check',
  OPTIONAL: 'Optional',
  CHECK_AGAIN: 'Check again',
  CONTINUE: 'Continue',
  SKIP: 'Skip for now',
  NEEDS_ONE: 'Install one of the tools that run agents to start your first one.',
  CHECKING: 'Checking…',
  SETUP_TITLE: 'Installing here. It may ask you a question.',
  RUNNING: 'Working…'
} as const

/** Remote desktop, offered in the tool check. Names of panes are System Settings' own. */
export const REMOTE_SETUP_COPY = {
  HEAD: 'Use this computer from your phone?',
  OPTIONAL: 'Optional',
  LEDE: 'See this screen from your own phone, from any network. Turn on remote control if you also want paired devices and agents to click and type here.',
  SCREEN_NAME: 'Screen & System Audio Recording',
  SCREEN_DOES: 'Lets your phone see this screen.',
  ACCESSIBILITY_NAME: 'Accessibility',
  ACCESSIBILITY_DOES: 'Lets your phone click and type here.',
  SWITCH_NAME: 'Allow remote desktop',
  SWITCH_DOES:
    'Your paired devices can unlock this computer with its password and take control, and agents can click and type here. It stays on after a restart until you turn it off, and keeps this computer awake while its lid is open.',
  ON: 'On',
  OFF: 'Off',
  RESTART_NEEDED: 'Restart needed',
  ALLOW: 'Allow',
  TURN_ON: 'Turn on',
  TURN_OFF: 'Turn off',
  RESTART: 'Restart Cookrew',
  TURN_ON_ROW: (name: string): string => `Turn on ${name} in System Settings.`,
  STALE: 'Already on there? Select it, press −, and add it again.'
} as const

/** A Setup line, in the tool check and the Routing panel alike (main/setup-line.ts). */
export const SETUP_LINE_COPY = {
  BUSY: 'The Setup pane is busy, so nothing was typed. Finish what it is doing there, or press Stop.',
  UNREADABLE: 'Cookrew could not tell if the Setup pane is free, so nothing was typed. Press Stop, then try again.',
  UNEXPECTED: 'That line is not one Cookrew runs, so nothing was typed.',
  OLD_DESKTOP: 'The Cookrew on this computer is too old to run this line. Update it first.',
  NOT_SENT: 'That line could not be sent. Try again.',
  UNWATCHED: 'It is running in the pane below. When it ends, press Check again.',
  OUT_OF_TOUCH: 'Cookrew lost touch with that line, and it may still be running. Look at the pane below.',
  FAILED: (code: number): string => `That did not work: it stopped with an error (exit ${code}). What it printed is in the pane below.`,
  STOPPED: 'Stopped before it finished.',
  LOST: 'That line ended without saying how it went. What it printed is in the pane below.',
  STILL_MISSING: (tool: string): string => `That finished, but ${tool} is still not found. What it printed is in the pane below.`,
  WAITING: 'Running below. The other buttons come back when it ends.',
  PASSWORD: 'It is asking for this computer’s password. Type it in the pane below and press Enter. Nothing shows as you type. If you do not have it, press Stop.',
  STOP: 'Stop'
} as const

export const TOOL_COPY = {
  claude: { name: 'Claude Code', does: 'Runs your agent. You need one of these four.' },
  codex: { name: 'Codex', does: 'Runs your agent. You need one of these four.' },
  pi: { name: 'Pi', does: 'Runs your agent. You need one of these four.' },
  opencode: { name: 'OpenCode', does: 'Runs your agent. You need one of these four.' },
  multiplexer: { name: 'herdr or tmux', does: 'Keeps your agents alive across restarts.' },
  chrome: { name: 'Chrome', does: 'Lets agents open and use web pages.' },
  magpie: { name: 'Magpie', does: 'Lets agents use other AI models.' },
  ollama: { name: 'Ollama', does: 'Gives agents short names, on this computer.' },
  xdotool: { name: 'xdotool', does: 'Lets your paired devices click and type on this computer, once you allow remote control.' }
} as const

export const TOOL_NOTES = {
  NOT_KEPT: 'Without it, your agents stop when you close Cookrew.',
  RESTART: 'Installed. Restart Cookrew to turn it on.',
  NOT_SIGNED_IN: 'Not signed in yet.',
  USES_ENDPOINT: 'Uses your own endpoint, so it needs no sign-in.',
  ADMIN: 'May need admin rights: it can ask for this computer’s password.'
} as const

export const FIX_LABELS = {
  INSTALL: 'Install',
  INSTALL_TMUX: 'Install tmux',
  HOMEBREW_FIRST: 'Install Homebrew first',
  GET: 'Download',
  SIGN_IN: 'Sign in'
} as const

export const FIRST_SCREEN_COPY = {
  ASK: 'What should your agent do?',
  LEDE: 'It can read, change and run files in the folder you choose, without stopping to ask. You can watch every step.',
  FOLDER: 'Choose a folder',
  FOLDER_CHANGE: 'Change',
  FOLDER_NOTE: 'Folder',
  TRY: 'Try one of these, or type your own',
  FOLDER_FAILED: 'That folder could not be used. Try another one.',
  RECHECK: 'Check this computer again',
  LATER: 'Look around first',
  BACK: 'Back to getting started',
  named: (folder: string): string => `This workspace is now called ${folder}.`
} as const

/** Real work, safe in any folder: two read it, one writes one new file. */
export const EXAMPLE_TASKS = [
  'Explain what is in this folder',
  'Find broken or outdated files here',
  'Write a short README for this folder'
] as const

/** The name an example's agent wears: the rule reads "Explain what is in this folder" as "Folder". */
const EXAMPLE_NAMES: Readonly<Record<string, string>> = {
  [EXAMPLE_TASKS[0]]: 'Folder Tour',
  [EXAMPLE_TASKS[1]]: 'File Check',
  [EXAMPLE_TASKS[2]]: 'Readme Writer'
}

export const exampleName = (task: string): string | null => EXAMPLE_NAMES[task.trim()] ?? null

/** While a first task waits for its agent. What the agent asks is its own, so these say what to do with it. */
export const WAIT_COPY = {
  starting: {
    title: (tool: string): string => `${tool} is starting`,
    lede: 'Your task goes in the moment it is ready.'
  },
  choice: {
    title: (tool: string): string => `${tool} has a question first`,
    lede: 'Answer it below with the arrow keys and Enter. Your task goes in right after.'
  },
  'sign-in': {
    title: (tool: string): string => `Sign in to ${tool}`,
    lede: 'Follow the steps below. A browser may open. Your task goes in right after.'
  },
  consent: {
    title: (tool: string): string => `${tool} asks before it works on its own`,
    lede: 'It will run commands without stopping for your approval. To go on, press ↓, then Enter, on Yes, I accept. No, exit closes it and brings your words back.'
  },
  TASK: 'Your task',
  CANCEL: 'Change my task',
  NO_ACCOUNT: 'No account? Use your own endpoint'
} as const

export const ENDPOINT_COPY = {
  HEAD: 'No Claude or Codex account?',
  ANTHROPIC: 'Anthropic API, runs on Pi or Claude Code',
  THIRD_PARTY: 'We recommend Pi here. Claude Code is built for Anthropic’s own API, and other services can refuse its requests.',
  SIMPLE: 'Use Claude Code in simple mode',
  SIMPLE_NOTE: 'More services accept it. It leaves out hooks, MCP servers and CLAUDE.md.',
  OPENAI: 'OpenAI API, runs on Codex or Pi',
  URL: 'Address',
  URL_HINT: 'https://api.example.com',
  KEY: 'Key',
  /** Each says what the code does and no more (agent-access.ts · state). */
  KEY_NOTE: {
    keychain: 'Kept encrypted by this computer’s keychain. It is sent only to this address.',
    file: 'Stored in a private file on this computer, not encrypted. It is sent only to this address.'
  },
  MODEL: 'Model',
  MODEL_HINT: 'The model’s id, as the service names it',
  SAVE: 'Check and save',
  SAVING: 'Checking…',
  CANCEL: 'Cancel',
  REMOVE: 'Remove',
  ON: 'Your agents use',
  SAVE_ROW: 'Set up',
  EDIT: 'Edit',
  KEY_KEEP: 'Leave it empty to keep the saved key.',
  MOVED: 'Agents already running were on the old address, and can no longer read the key. Close them and start new ones.',
  KEY_NEW_ADDRESS: (host: string): string => `A new address needs its key pasted again. The saved key is only sent to ${host}.`,
  FAILED: 'That could not be saved. Try again.'
} as const

/** A turn the model service refused. The sentence comes first; its own words stay behind details. */
export const REFUSED_COPY = {
  request: 'The model service refused this request.',
  key: 'The model service refused the key.',
  limit: 'The model service says it has had too many requests. Try again in a moment.',
  service: 'The model service had a problem on its side. Try again in a moment.',
  reach: 'The model service could not be reached.',
  DETAILS: 'What it said',
  SIMPLE_WHY: 'Simple mode may fix this, because more services accept it. For every Claude Code agent on this endpoint, it leaves out hooks, MCP servers and CLAUDE.md.',
  SIMPLE_GO: 'Use simple mode',
  SIMPLE_WORKING: 'Restarting…',
  SIMPLE_DONE: 'Simple mode is on and this agent has restarted. Send your task again.',
  SIMPLE_SAVED: 'Simple mode is on for every Claude Code agent on this endpoint. This one picks it up when it next starts.',
  SIMPLE_FAILED: 'That could not be changed. Try again.'
} as const

export const HINT_COPY = {
  PHONE_TITLE: 'Your agent finished its first task',
  PHONE_LEDE: 'Follow your agents from your phone, and answer them when they ask.',
  PHONE_GO: 'Show the QR code',
  NOT_NOW: 'Not now',
  SECOND_TITLE: 'You can run more than one agent',
  SECOND_LEDE: 'Press ✕ beside the name in the prompt box, or ＋ when it is folded, and give a new agent its own task. They work side by side.',
  SECOND_GO: 'Got it'
} as const
