import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completionRequest,
  createHarnessCompletionRequester,
  explicitGrantEnv,
  servedGrantPreflight,
  type HarnessCompletionRequest
} from '../src/main/served-grant-preflight'
import { grantLedgerPath, serviceGrants } from '../src/main/service-grants-store'

const TEMPLATE = {
  serviceId: 'svc-research',
  templateId: 'research-crew',
  slug: 'research',
  access: 'account' as const
}

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'grant-preflight-test-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('explicit grant environment', () => {
  it('passes only named values and never ambient owner secrets', () => {
    const ownerEnvFor = vi.fn(() => ({
      GRANTED_FAKE: 'allowed-fake-value',
      AMBIENT_FAKE: 'must-not-cross',
      HOME: '/outside',
      PATH: '/host/bin'
    }))
    expect(
      explicitGrantEnv(
        {
          envKeysFor: () => ['GRANTED_FAKE', 'HOME', 'PATH'],
          ownerEnvFor,
          filesFor: () => []
        },
        'svc-research'
      )
    ).toEqual({ GRANTED_FAKE: 'allowed-fake-value' })
    expect(ownerEnvFor).toHaveBeenCalledWith('svc-research')
  })

  it('does not read owner env at all when no env/envFile names were granted', () => {
    const ownerEnvFor = vi.fn(() => ({ AMBIENT_FAKE: 'must-not-be-read' }))
    expect(
      explicitGrantEnv(
        { envKeysFor: () => [], ownerEnvFor, filesFor: () => [] },
        'svc-research'
      )
    ).toEqual({})
    expect(ownerEnvFor).not.toHaveBeenCalled()
  })
})

describe('minimal native harness requests', () => {
  it.each([
    ['claude --permission-mode bypassPermissions', 'claude', 'claude', '--print'],
    ['pi --model qwen-local/fake-model', 'pi', 'pi', '--no-tools'],
    ['codex --model fake-model', 'codex', 'codex', 'exec'],
    ['opencode --model fake/model', 'opencode', 'opencode', 'run']
  ] as const)('builds %s without replaying the saved shell command', (command, harness, file, flag) => {
    const request = completionRequest(command, { GRANTED_FAKE: 'fake-value' })
    expect(request).toMatchObject({ harness, file, env: { GRANTED_FAKE: 'fake-value' } })
    expect(request?.args).toContain(flag)
    expect(request?.args.at(-1)).toBe('Reply with exactly: OK')
    expect(request?.args.join(' ')).not.toContain('bypassPermissions')
  })

  it('preserves only a closed model token and refuses an unknown shell harness', () => {
    expect(completionRequest('pi --model qwen-local/fake:model', {})?.args).toContain(
      'qwen-local/fake:model'
    )
    expect(completionRequest('pi --model "bad model"', {})?.args).not.toContain('bad model')
    expect(completionRequest('bash -lc anything', {})).toBeNull()
  })
})

describe('served grant preflight seam', () => {
  it('sends one injected request with the orch harness and explicit grant', async () => {
    const seen: HarnessCompletionRequest[] = []
    const preflight = servedGrantPreflight({
      orch: { commandOf: (id) => (id === TEMPLATE.templateId ? 'pi --model fake/model' : null) },
      grants: {
        envKeysFor: () => ['QWEN_FAKE_KEY'],
        ownerEnvFor: () => ({ QWEN_FAKE_KEY: 'fake-value', AMBIENT_FAKE: 'hidden' }),
        filesFor: () => []
      },
      request: async (request) => {
        seen.push(request)
        return true
      }
    })

    await expect(preflight.check(TEMPLATE)).resolves.toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      harness: 'pi',
      env: { QWEN_FAKE_KEY: 'fake-value' }
    })
    expect(seen[0].env.AMBIENT_FAKE).toBeUndefined()
  })

  it('fails closed for unusable, throwing, missing, and unknown harnesses', async () => {
    const withRequest = (command: string | null, request: () => Promise<boolean>) =>
      servedGrantPreflight({
        orch: { commandOf: () => command },
        grants: { envKeysFor: () => [], ownerEnvFor: () => ({}), filesFor: () => [] },
        request
      }).check(TEMPLATE)

    await expect(withRequest('claude', async () => false)).resolves.toBe(false)
    await expect(withRequest('claude', async () => Promise.reject(new Error('provider detail')))).resolves.toBe(false)
    await expect(withRequest(null, async () => true)).resolves.toBe(false)
    await expect(withRequest('bash', async () => true)).resolves.toBe(false)
  })
})

describe('declared file staging', () => {
  it('stages a usable Pi models file at 0600 and does not spend the grant', async () => {
    const base = tempRoot()
    const source = path.join(base, 'fake-models.json')
    const config = path.join(base, 'service-grants.json')
    const fakeContents = '{"providers":{"fake":{}}}'
    writeFileSync(source, fakeContents, { mode: 0o644 })
    writeFileSync(
      config,
      JSON.stringify({
        [TEMPLATE.serviceId]: {
          files: [{ from: source, to: '.pi/agent/models.json' }],
          maxSessions: 1
        }
      }),
      { mode: 0o600 }
    )
    const spentFile = grantLedgerPath(base)
    const spentBefore = `${JSON.stringify({ [TEMPLATE.serviceId]: 0 }, null, 2)}\n`
    writeFileSync(spentFile, spentBefore, { mode: 0o600 })
    const grants = serviceGrants(base, () => undefined)
    const run = vi.fn(async (request: HarnessCompletionRequest, context: { home: string }) => {
      expect(request.harness).toBe('pi')
      expect(request.files).toEqual([{ from: source, to: '.pi/agent/models.json' }])
      const staged = path.join(context.home, '.pi', 'agent', 'models.json')
      expect(readFileSync(staged, 'utf8')).toBe(fakeContents)
      expect(lstatSync(staged).mode & 0o777).toBe(0o600)
      return true
    })
    const preflight = servedGrantPreflight({
      orch: { commandOf: () => 'pi --model fake/model' },
      grants,
      request: createHarnessCompletionRequester(run)
    })

    await expect(preflight.check(TEMPLATE)).resolves.toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    // Only provision() spends. A compatibility check never rewrites the ledger.
    expect(readFileSync(spentFile, 'utf8')).toBe(spentBefore)
  })

  it('refuses a staged-file traversal before the injected runner executes', async () => {
    const root = tempRoot()
    const source = path.join(root, 'fake-models.json')
    writeFileSync(source, '{}')
    const run = vi.fn(async () => true)
    const request = completionRequest('pi', {}, [{ from: source, to: '../outside.json' }])!
    const stage = createHarnessCompletionRequester(run)

    await expect(stage(request)).rejects.toThrow(/outside the session/)
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(path.join(root, 'outside.json'))).toBe(false)
  })
})
