import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * THE RELEASE BUILDS THE TWO STATIC SITES FROM ITS OWN TAG (.github/workflows/release.yml):
 * the console and cookrew.dev, after the release is published, since the site
 * names that release's builds. Two jobs on purpose: the one that runs this
 * repository's code and its dependencies holds no key to the host, and the one
 * that holds the key runs none of it.
 */

const workflow = readFileSync(path.resolve(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8')
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
const job = (name: string): string => {
  const from = jobs.indexOf(`\n  ${name}:\n`)
  if (from === -1) throw new Error(`no job ${name}`)
  const rest = jobs.slice(from + 1)
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('the job that builds them', () => {
  const web = job('web')

  it('runs after the release is published, on a tag, and may only read the repository', () => {
    expect(web).toMatch(/\n    needs: publish\n/)
    expect(web).toContain("startsWith(github.ref, 'refs/tags/')")
    expect(web).toMatch(/\n    permissions:\n      contents: read\n/)
  })

  it('installs without running any package’s install script: nothing here needs the app’s native parts', () => {
    expect(web).toContain('npm ci --ignore-scripts')
  })

  it('builds the console under the tag’s version and holds it to the size gate', () => {
    expect(web).toContain('COOKREW_CONSOLE_VERSION="${GITHUB_REF_NAME#v}"')
    expect(web).toContain('npm run console:build')
    expect(web).toContain('npm run console:size')
    expect(web.indexOf('npm run console:build')).toBeLessThan(web.indexOf('npm run console:size'))
  })

  it('builds the site for this very release, and stops if its Mac build cannot be read', () => {
    expect(web).toContain('COOKREW_SITE_RELEASE: ${{ github.ref_name }}')
    expect(web).toMatch(/COOKREW_SITE_REQUIRE_RELEASE: ['"]?1['"]?/)
    expect(web).toContain('npm run site:build')
  })

  it('hands both on as artifacts and holds no key to the host', () => {
    expect(web).toContain('out/console')
    expect(web).toContain('out/site')
    expect(web.match(/overwrite: true/g)).toHaveLength(2)
    expect(web).not.toMatch(/CLOUDFLARE/)
  })
})

describe('the job that uploads them', () => {
  const deploy = job('web-deploy')

  it('waits for the build, and runs only when the owner has switched it on, for a release that is not a prerelease', () => {
    expect(deploy).toMatch(/\n    needs: web\n/)
    expect(deploy).toContain("vars.COOKREW_PAGES_DEPLOY == 'true'")
    expect(deploy).toContain("!contains(github.ref_name, '-')")
  })

  it('is the only place the host’s key is named, and it runs none of this repository’s code with it', () => {
    expect(deploy).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow.match(/CLOUDFLARE_API_TOKEN/g)?.length).toBe(2)
    expect(deploy).not.toContain('actions/checkout')
    expect(deploy).not.toMatch(/npm (ci|install|run)/)
    expect(deploy).toMatch(/\n    permissions: \{\}\n/)
  })

  it('takes the key from an environment of its own, uses one exact version of the host’s tool, and uploads one release at a time', () => {
    // The environment is where the owner restricts the key to release tags.
    expect(deploy).toMatch(/\n    environment: web-release\n/)
    expect(deploy).toMatch(/\n    concurrency:\n      group: web-release\n      cancel-in-progress: false\n/)
    const tools = [...deploy.matchAll(/npx --yes (wrangler@\S+)/g)].map(([, tool]) => tool)
    expect(tools).toHaveLength(2)
    for (const tool of tools) expect(tool).toMatch(/^wrangler@\d+\.\d+\.\d+$/)
  })

  it('uploads files only: a directory holding code the host would run is refused', () => {
    for (const name of ['_worker.js', '_routes.json', 'functions']) expect(deploy).toContain(`test ! -e "$dir/${name}"`)
  })

  it('uploads each directory to its own project, as the production branch', () => {
    expect(deploy).toMatch(/pages deploy console --project-name="\$CONSOLE_PROJECT" --branch=main/)
    expect(deploy).toMatch(/pages deploy site --project-name="\$SITE_PROJECT" --branch=main/)
    // The console first: the site's "Open console" must never point at a console that is not there yet.
    expect(deploy.indexOf('pages deploy console')).toBeLessThan(deploy.indexOf('pages deploy site'))
  })
})
