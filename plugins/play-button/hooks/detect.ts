import type { Plan } from '../types'

type Entry = { name: string; kind: string }
export type Fs = {
  read: (path: string) => Promise<unknown>
  list: (path?: string) => Promise<Entry[]>
  exists: (path: string) => Promise<boolean>
}

type Svc = Plan['services'][number]
type Setup = Plan['setup'][number]
type Found = { source: string; service: Svc; setup: Setup[] }

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'venv', 'env', 'docs', 'doc', 'test', 'tests', 'e2e', 'scripts', 'tmp', 'vendor', 'target', 'coverage', 'public', 'static', 'assets', 'migrations'])
const CONTAINERS = new Set(['apps', 'packages', 'services'])
const DEV_SCRIPTS = ['dev', 'start:dev', 'dev:server', 'develop', 'serve', 'start']
const MAKE_TARGETS = ['dev', 'up', 'run', 'serve', 'start']
const SCRIPT_FILES = ['bin/dev', 'dev.sh', 'run.sh', 'start.sh', 'run-dev.sh']
const INFRA = /^(postgres|postgis|mysql|mariadb|redis|mongo|mongodb|rabbitmq|kafka|zookeeper|minio|mailhog|mailpit|elasticsearch|memcached|localstack|adminer|pgadmin)/i

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'app'
const join = (a: string, b: string) => (a === '.' ? b : `${a}/${b}`)
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const detect = async (fs: Fs, cwd: string): Promise<Plan> => {
  const text = async (p: string) => {
    try {
      const r = await fs.read(p)
      return typeof r === 'string' ? r : ''
    } catch {
      return ''
    }
  }
  const has = (p: string) => fs.exists(p).catch(() => false)
  const json = async (p: string) => {
    try {
      return JSON.parse(await text(p))
    } catch {
      return null
    }
  }
  const repo = slug(base(cwd))

  // 0. A recipe the person (or Claude) wrote down always wins.
  const recipe = await json('.claude/play.json')
  if (recipe && Array.isArray(recipe.services) && recipe.services.length > 0) {
    return {
      source: '.claude/play.json',
      setup: (Array.isArray(recipe.setup) ? recipe.setup : []).map((s: any, i: number) => ({
        label: s.label ?? `setup ${i + 1}`,
        cmd: String(s.cmd),
        cwd: s.cwd ?? '.',
      })),
      services: recipe.services.map((s: any, i: number) => ({
        id: slug(s.name ?? `svc${i}`),
        name: s.name ?? `svc${i}`,
        cmd: String(s.cmd),
        cwd: s.cwd ?? '.',
      })),
    }
  }

  // 1. Procfile: the repo already lists what runs together.
  for (const file of ['Procfile.dev', 'Procfile']) {
    const body = await text(file)
    const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && /^[\w-]+:/.test(l))
    const services = lines
      .map(l => ({ name: l.slice(0, l.indexOf(':')), cmd: l.slice(l.indexOf(':') + 1).trim() }))
      .filter(s => s.name !== 'release' && s.cmd)
      .map(s => ({ id: slug(s.name), name: `${repo}-${s.name}`, cmd: s.cmd, cwd: '.' }))
    if (services.length > 0) return { source: file, setup: [], services }
  }

  const pmOf = async (dir: string) => {
    for (const d of dir === '.' ? ['.'] : [dir, '.']) {
      if (await has(join(d, 'pnpm-lock.yaml'))) return 'pnpm'
      if (await has(join(d, 'yarn.lock'))) return 'yarn'
      if (await has(join(d, 'bun.lockb')) || (await has(join(d, 'bun.lock')))) return 'bun'
    }
    return 'npm'
  }
  const venvOf = async (dir: string) => {
    for (const d of dir === '.' ? ['.'] : [dir, '.']) {
      for (const v of ['.venv', 'venv']) if (await has(join(d, v, 'bin/python'))) return `${cwd}/${join(d, v)}/bin`
    }
    return ''
  }

  const nodeFound = async (dir: string, label: string, pkg: any): Promise<Found | null> => {
    const scripts = pkg?.scripts ?? {}
    const script = DEV_SCRIPTS.find(s => typeof scripts[s] === 'string')
    if (!script) return null
    const pm = await pmOf(dir)
    const installed = (await has(join(dir, 'node_modules'))) || (await has('node_modules'))
    return {
      source: 'package.json',
      service: { id: slug(label), name: label, cmd: `${pm} run ${script}`, cwd: dir },
      setup: installed ? [] : [{ label: `${label}: install`, cmd: `${pm} install`, cwd: dir }],
    }
  }

  // One directory's best guess at "how do I start this".
  const probe = async (dir: string): Promise<Found | null> => {
    const label = dir === '.' ? repo : `${repo}-${slug(base(dir))}`
    const pkg = await json(join(dir, 'package.json'))
    if (pkg) {
      const f = await nodeFound(dir, label, pkg)
      if (f) return f
    }

    const py = (await text(join(dir, 'requirements.txt'))) + (await text(join(dir, 'pyproject.toml')))
    const venv = await venvOf(dir)
    const env = venv ? `export PATH=${q(venv)}:"$PATH"; ` : ''
    if (await has(join(dir, 'manage.py'))) {
      return { source: 'Django', setup: [], service: { id: slug(label), name: label, cmd: `${env}python3 manage.py runserver`, cwd: dir } }
    }
    if (/fastapi|uvicorn|starlette/i.test(py)) {
      let target = ''
      for (const [file, mod] of [['app/main.py', 'app.main'], ['main.py', 'main'], ['app.py', 'app'], ['server.py', 'server'], ['api/main.py', 'api.main'], ['src/main.py', 'src.main']]) {
        if (await has(join(dir, file))) {
          target = mod
          break
        }
      }
      if (target) {
        return { source: 'FastAPI', setup: [], service: { id: slug(label), name: label, cmd: `${env}python3 -m uvicorn ${target}:app --reload --port 8000`, cwd: dir } }
      }
    }
    if (/flask/i.test(py)) {
      for (const file of ['app.py', 'main.py', 'server.py', 'wsgi.py']) {
        if (await has(join(dir, file))) {
          return { source: 'Flask', setup: [], service: { id: slug(label), name: label, cmd: `${env}python3 ${file}`, cwd: dir } }
        }
      }
    }
    if ((await has(join(dir, 'go.mod'))) && (await has(join(dir, 'main.go')))) {
      return { source: 'Go', setup: [], service: { id: slug(label), name: label, cmd: 'go run .', cwd: dir } }
    }
    if (await has(join(dir, 'Cargo.toml'))) {
      return { source: 'Cargo', setup: [], service: { id: slug(label), name: label, cmd: 'cargo run', cwd: dir } }
    }
    if (await has(join(dir, 'bin/rails'))) {
      return { source: 'Rails', setup: [], service: { id: slug(label), name: label, cmd: 'bin/rails server', cwd: dir } }
    }
    const make = await text(join(dir, 'Makefile'))
    const target = MAKE_TARGETS.find(t => new RegExp(`^${t}\\s*:`, 'm').test(make))
    if (target) {
      return { source: 'Makefile', setup: [], service: { id: slug(label), name: label, cmd: `make ${target}`, cwd: dir } }
    }
    for (const file of SCRIPT_FILES) {
      if (await has(join(dir, file))) {
        return { source: file, setup: [], service: { id: slug(label), name: label, cmd: `./${file}`, cwd: dir } }
      }
    }
    if (await has(join(dir, 'index.html'))) {
      return { source: 'static site', setup: [], service: { id: slug(label), name: label, cmd: 'python3 -m http.server 8000', cwd: dir } }
    }
    return null
  }

  // 2. Root orchestrators: a workspace `dev` script, a Makefile target, a dev script.
  const rootPkg = await json('package.json')
  if (rootPkg?.workspaces) {
    const f = await nodeFound('.', repo, rootPkg)
    if (f) return { source: 'package.json (workspace)', setup: f.setup, services: [f.service] }
  }
  const rootMake = await text('Makefile')
  // A Makefile that documents several "Run ..." targets (make api / make web / ...) is a
  // list of services; daemons that start and return (db-up) go first as setup steps.
  const documented = [...rootMake.matchAll(/^([A-Za-z0-9_-]+):[^\n#]*##\s*(.*)$/gm)]
    .map(m => ({ name: m[1], note: m[2] }))
    .filter(t => /^(run|start|serve|launch|boot)\b/i.test(t.note))
    // Never offer a target that ships, tests or checks, or one with preconditions.
    .filter(t => !/deploy|release|publish|check|test|eval|lint|hygiene|migrat|install|seed|bootstrap|build|clean|fmt|hook|down|push|prod|audit/i.test(t.name))
    .filter(t => !/needs|requires|opt-in|deploy|test|eval|check|hook|workflow|suite|lint|secret|migrat/i.test(t.note))
  if (documented.length >= 2) {
    const isDaemon = (n: string) => /(^|[-_])(up|start|setup)$/.test(n)
    const services = documented.filter(t => !isDaemon(t.name)).map(t => ({ id: slug(t.name), name: `${repo}-${t.name}`, cmd: `make ${t.name}`, cwd: '.' }))
    if (services.length > 0) {
      const setup = documented.filter(t => isDaemon(t.name)).map(t => ({ label: t.name, cmd: `make ${t.name}`, cwd: '.' }))
      return { source: 'Makefile', setup, services }
    }
  }
  const rootTarget = MAKE_TARGETS.find(t => new RegExp(`^${t}\\s*:`, 'm').test(rootMake))
  if (rootTarget) {
    return { source: 'Makefile', setup: [], services: [{ id: repo, name: repo, cmd: `make ${rootTarget}`, cwd: '.' }] }
  }
  for (const file of SCRIPT_FILES) {
    if (await has(file)) return { source: file, setup: [], services: [{ id: repo, name: repo, cmd: `./${file}`, cwd: '.' }] }
  }

  // 3. Each directory on its own (monorepo layout), root last.
  const found: Found[] = []
  const root = (await fs.list('.').catch(() => [])).filter(e => e.kind === 'directory')
  const dirs: string[] = []
  for (const e of root) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    if (CONTAINERS.has(e.name)) {
      const kids = (await fs.list(e.name).catch(() => [])).filter(k => k.kind === 'directory' && !k.name.startsWith('.') && !SKIP.has(k.name))
      for (const k of kids) dirs.push(`${e.name}/${k.name}`)
    } else dirs.push(e.name)
  }
  for (const d of dirs) {
    const f = await probe(d)
    if (f) found.push(f)
  }
  if (found.length === 0) {
    const f = await probe('.')
    if (f) found.push(f)
  }

  // Docker: infra-only compose files start first; a compose that builds the app is the app.
  let compose: Found | null = null
  for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    if (!(await has(file))) continue
    const body = await text(file)
    const block = body.match(/^services:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m)?.[1] ?? ''
    const indent = block.match(/^([ \t]+)\S/m)?.[1] ?? '  '
    const names = [...block.matchAll(new RegExp(`^${indent}([A-Za-z0-9_.-]+):\\s*$`, 'gm'))].map(m => m[1])
    const isInfraOnly = names.length > 0 && names.every(n => INFRA.test(n))
    if (found.length > 0 && !isInfraOnly) continue
    compose = {
      source: file,
      setup: [],
      service: { id: 'compose', name: `${repo}-docker${names.length ? ` (${names.join(', ')})` : ''}`, cmd: 'docker compose up', cwd: '.' },
    }
    break
  }

  const all = compose ? [compose, ...found] : found
  const seen = new Set<string>()
  const services = all.map(f => f.service).filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)))
  // Several services default to one port; hand each its own.
  let next = 8000
  for (const svc of services) {
    if (/--port 8000|http\.server 8000/.test(svc.cmd)) {
      svc.cmd = svc.cmd.replace(/(--port |http\.server )8000/, `$1${next}`)
      next += 1
    }
  }
  const sources = [...new Set(all.map(f => f.source))]
  return { source: sources.join(' + '), setup: all.flatMap(f => f.setup), services }
}
