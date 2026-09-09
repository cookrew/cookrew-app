import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { harnessFor, type HarnessId } from './harness'
import { seedClaudeOnboarding } from './served-onboarding'
import { grantable } from './session-env'
import { stageGrantedFiles } from './service-grants-store'
import type { GrantedFile } from './service-grants'
import type { ServedTemplate } from './session-served'

const PREFLIGHT_PROMPT = 'Reply with exactly: OK'
const PREFLIGHT_TIMEOUT_MS = 60_000

export interface GrantPreflightSource {
  /** Names explicitly granted to this service, including names from envFile. */
  envKeysFor(serviceId: string): readonly string[]
  /** Owner + envFile values. The preflight filters this back to envKeysFor. */
  ownerEnvFor(serviceId: string): Record<string, string | undefined>
  /** Declared file grants. Reading these declarations does not spend budget. */
  filesFor(serviceId: string): readonly GrantedFile[]
}

export interface OrchHarnessSource {
  /** The saved template's orch command, or null when it cannot be resolved. */
  commandOf(templateId: string): string | null
}

export interface HarnessCompletionRequest {
  harness: HarnessId
  file: string
  args: readonly string[]
  /** Only explicitly granted values. Safe process infrastructure is adapter-owned. */
  env: Readonly<Record<string, string>>
  files: readonly GrantedFile[]
}

export type HarnessCompletionRequester = (request: HarnessCompletionRequest) => Promise<boolean>

export interface ServedGrantPreflight {
  check(template: ServedTemplate): Promise<boolean>
}

/** Build the product gate. Tests inject `request`, so they make zero network calls. */
export function servedGrantPreflight(input: {
  orch: OrchHarnessSource
  grants: GrantPreflightSource
  request: HarnessCompletionRequester
}): ServedGrantPreflight {
  return {
    async check(template) {
      const command = input.orch.commandOf(template.templateId)
      const request =
        command === null
          ? null
          : completionRequest(
              command,
              explicitGrantEnv(input.grants, template.serviceId),
              input.grants.filesFor(template.serviceId)
            )
      if (request === null) return false
      try {
        return await input.request(request)
      } catch {
        // Provider response bodies can echo credentials. Never log or surface them.
        return false
      }
    }
  }
}

/** Filter ownerEnvFor back down to the grant's names. Ambient secrets stay out. */
export function explicitGrantEnv(
  grants: GrantPreflightSource,
  serviceId: string
): Record<string, string> {
  const names = [...new Set(grants.envKeysFor(serviceId))]
  if (names.length === 0) return {}
  const owner = grants.ownerEnvFor(serviceId)
  const env: Record<string, string> = {}
  for (const name of names) {
    // envFile keys take the same path as direct env grants here; do not let a
    // file redefine the disposable HOME/PATH that makes this probe isolated.
    if (!grantable(name)) continue
    const value = owner[name]
    if (typeof value === 'string' && value.length > 0) env[name] = value
  }
  return env
}

/** The minimal non-interactive completion each shipped harness speaks. */
export function completionRequest(
  command: string,
  env: Readonly<Record<string, string>>,
  files: readonly GrantedFile[] = []
): HarnessCompletionRequest | null {
  const harness = harnessFor(command)
  if (harness === null) return null
  const model = commandOption(command, '--model')
  switch (harness.id) {
    case 'claude':
      return {
        harness: 'claude',
        file: 'claude',
        args: [
          '--print',
          '--output-format',
          'json',
          '--max-turns',
          '1',
          '--tools',
          '',
          ...(model ? ['--model', model] : []),
          PREFLIGHT_PROMPT
        ],
        env,
        files
      }
    case 'pi': {
      const provider = commandOption(command, '--provider')
      return {
        harness: 'pi',
        // THE WRAPPER IS THE HARNESS. A team whose orch runs
        // ~/.cookrew/bin/qwen-pi (`exec pi --provider qwen-local --model …`)
        // was probed here as bare `pi`, which went to pi's DEFAULT provider
        // with the wrapper's key — a 401 — and every serve of that team was
        // refused as 'grant-unusable' while the same team ran fine on the
        // canvas. The probe runs what the orch runs; the flags it carries in
        // its own body come along for free.
        file: piExecutable(command),
        args: [
          '--print',
          '--no-tools',
          '--no-session',
          '--no-context-files',
          ...(provider ? ['--provider', provider] : []),
          ...(model ? ['--model', model] : []),
          PREFLIGHT_PROMPT
        ],
        env,
        files
      }
    }
    case 'codex':
      return {
        harness: 'codex',
        file: 'codex',
        args: [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          ...(model ? ['--model', model] : []),
          PREFLIGHT_PROMPT
        ],
        env,
        files
      }
    case 'opencode':
      return {
        harness: 'opencode',
        file: 'opencode',
        args: ['run', ...(model ? ['--model', model] : []), PREFLIGHT_PROMPT],
        env,
        files
      }
  }
}

/**
 * The pi executable a saved command names: bare `pi`, or an absolute path to
 * a `*-pi` wrapper (isPiCommand's own rule). Only a path with no shell
 * metacharacters qualifies — anything else is probed as `pi`, never replayed.
 */
function piExecutable(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  // `~` is the shell's; execFile does not expand it, and the one wrapper this
  // exists for is written that way in some snapshots.
  const expanded = first.startsWith('~/') ? path.join(homedir(), first.slice(2)) : first
  const absolute = path.isAbsolute(expanded) && !expanded.split('/').includes('..')
  const clean = /^[A-Za-z0-9._/-]+$/.test(expanded) && /-pi$/.test(path.basename(expanded))
  return absolute && clean ? expanded : 'pi'
}

/** Accept only a closed model token; never replay a saved shell command. */
function commandOption(command: string, name: string): string | null {
  const match = command.match(new RegExp(`(?:^|\\s)${name}(?:=|\\s+)([^\\s"']+)`))
  const value = match?.[1]
  return value && /^[A-Za-z0-9._:/-]+$/.test(value) ? value : null
}

/**
 * Production requester. One disposable HOME, one bounded completion, no output.
 * The executable builds its native request shape. If an emulation server rejects
 * that shape, the owner can fix its server-side template; Cookrew deliberately
 * does not mutate client requests to work around it.
 */
export interface HarnessCompletionContext {
  home: string
  env: NodeJS.ProcessEnv
}

export type HarnessCompletionRunner = (
  request: HarnessCompletionRequest,
  context: HarnessCompletionContext
) => Promise<boolean>

/** Stage a disposable probe around an injected runner. */
export function createHarnessCompletionRequester(
  run: HarnessCompletionRunner
): HarnessCompletionRequester {
  return async (request) => {
    const home = mkdtempSync(path.join(tmpdir(), 'cookrew-grant-preflight-'))
    try {
      stageGrantedFiles(request.files, home)
      if (request.harness === 'claude') {
        const suffix = request.env.ANTHROPIC_API_KEY?.trim().slice(-20)
        seedClaudeOnboarding(home, suffix)
      }
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        TMPDIR: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        TERM: 'dumb',
        ...request.env
      }
      return await run(request, { home, env })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const runHarnessCompletion: HarnessCompletionRunner = (request, context) =>
  new Promise<boolean>((resolve) => {
    const child = execFile(
      request.file,
      [...request.args],
      {
        cwd: context.home,
        env: context.env,
        timeout: PREFLIGHT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024
      },
      (error, stdout) => resolve(error === null && String(stdout).trim().length > 0)
    )
    // EVERY SHIPPED HARNESS READS A PIPED STDIN TO EOF before it answers, and
    // execFile hands the child an open pipe. The probe therefore sat at its
    // 60s timeout and every serve was refused as 'grant-unusable' — with the
    // wrapper, the key and the provider all correct. Nothing is ever written
    // here; the pipe is closed so the prompt on argv is the whole input.
    child.stdin?.end()
  })

export const requestHarnessCompletion: HarnessCompletionRequester =
  createHarnessCompletionRequester(runHarnessCompletion)
