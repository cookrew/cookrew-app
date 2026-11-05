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

export const TOOL_COPY = {
  claude: { name: 'Claude Code', does: 'Runs your agent. You need one of these four.' },
  codex: { name: 'Codex', does: 'Runs your agent. You need one of these four.' },
  pi: { name: 'Pi', does: 'Runs your agent. You need one of these four.' },
  opencode: { name: 'OpenCode', does: 'Runs your agent. You need one of these four.' },
  multiplexer: { name: 'herdr or tmux', does: 'Keeps your agents alive across restarts.' },
  chrome: { name: 'Chrome', does: 'Lets agents open and use web pages.' },
  magpie: { name: 'Magpie', does: 'Lets agents use other AI models.' },
  ollama: { name: 'Ollama', does: 'Gives agents short names, on this computer.' }
} as const

export const TOOL_NOTES = {
  NOT_KEPT: 'Without it, your agents stop when you close Cookrew.',
  RESTART: 'Installed. Restart Cookrew to turn it on.',
  NOT_SIGNED_IN: 'Not signed in yet.',
  USES_ENDPOINT: 'Uses your own endpoint, so it needs no sign-in.'
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
  ANTHROPIC: 'Anthropic API, runs on Claude Code or Pi',
  OPENAI: 'OpenAI API, runs on Codex or Pi',
  URL: 'Address',
  URL_HINT: 'https://api.example.com',
  KEY: 'Key',
  KEY_NOTE: 'Sealed on this computer. It is sent only to this address.',
  MODEL: 'Model',
  MODEL_HINT: 'The model’s id, as the service names it',
  SAVE: 'Check and save',
  SAVING: 'Checking…',
  CANCEL: 'Cancel',
  REMOVE: 'Remove',
  ON: 'Your agents use',
  SAVE_ROW: 'Set up',
  FAILED: 'That could not be saved. Try again.'
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
