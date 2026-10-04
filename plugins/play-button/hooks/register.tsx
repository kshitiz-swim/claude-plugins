import type { Register } from 'claude-code'

import type { Plan, Play, Svc } from '../types'
import { detect } from './detect'

const play = { plugin: 'play-button', key: 'play' } as const
const PANE = 'play-button'
const TAIL = 40

// A new process group per service, so stopping kills the dev server's children
// too. $$ is the group leader's pid after exec; it is written to a pidfile.
const LAUNCH = [
  'mkdir -p "$(dirname "$1")"; echo $$ > "$1"; cd "$2" || exit 1',
  'unset PORT',
  'for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done',
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/go/bin:$PATH"',
  `exec perl -e 'setpgrp(0,0); exec @ARGV' /bin/zsh -lc "$3"`,
].join('\n')

const KILL = [
  'p=$(cat "$1" 2>/dev/null); [ -n "$p" ] || exit 0',
  'kill -TERM -- "-$p" 2>/dev/null',
  'i=0; while kill -0 -- "-$p" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.25; i=$((i+1)); done',
  'kill -KILL -- "-$p" 2>/dev/null; rm -f "$1"; exit 0',
].join('\n')

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'")]*/i

// Reads are absolute: the session's working directory can move under us.
const abs = (path = '.') => (path.startsWith('/') ? path : path === '.' ? model.cwd : `${model.cwd}/${path}`)
const fsOf = ($: any) => ({
  read: (path: string) => $.fs.read(abs(path)),
  list: (path?: string) => $.fs.list(abs(path)),
  exists: (path: string) => $.fs.exists(abs(path)),
})

const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

const isLive = (s: Svc) => s.status === 'starting' || s.status === 'running'
const DOT: Record<string, string> = { starting: '◌', running: '●', failed: '✗', stopped: '○', done: '✓' }
const COLOR: Record<string, string> = { starting: 'yellow', running: 'green', failed: 'red', stopped: 'gray', done: 'green' }

const EMPTY: Play = { cwd: '', project: '', plan: null, services: [], msg: '', isBusy: false, now: 0 }

// The module owns the truth; $.state mirrors it for drawing.
let model: Play = EMPTY
let home = ''
const stopping = new Set<string>()

function pidfile(id: string) {
  return `${home}/.claude/play-button/pids/${hash(model.cwd)}-${id}.pid`
}

async function publish($: any, patch: Partial<Play>) {
  model = { ...model, ...patch, now: await $.clock.now() }
  await $.state.set(play, model)
}

async function patchSvc($: any, id: string, patch: Partial<Svc>, line?: string) {
  const services = model.services.map(s => {
    if (s.id !== id) return s
    const tail = line ? [...s.tail, ...line.split('\n').filter(Boolean)].slice(-TAIL) : s.tail
    return { ...s, ...patch, tail }
  })
  await publish($, { services })
}

async function stopAll($: any, timeoutMs = 30000) {
  const live = model.services.filter(isLive)
  live.forEach(s => stopping.add(s.id))
  await Promise.all(live.map(s => $.process.run(['/bin/sh', '-c', KILL, 'x', pidfile(s.id)], { timeoutMs }).catch(() => undefined)))
}

async function launch($: any, plan: Plan, svc: Plan['services'][number]) {
  const at = await $.clock.now()
  const fresh: Svc = { id: svc.id, name: svc.name, cmd: svc.cmd, cwd: svc.cwd, status: 'starting', url: '', startedAt: at, exit: -1, tail: [] }
  await publish($, { services: [...model.services.filter(s => s.id !== svc.id), fresh] })
  stopping.delete(svc.id)

  const dir = svc.cwd.startsWith('/') ? svc.cwd : `${model.cwd}/${svc.cwd}`
  const stream = $.process.spawn({ argv: ['/bin/sh', '-c', LAUNCH, 'x', pidfile(svc.id), dir, svc.cmd] })
  // Nothing prints a "ready" line everywhere; surviving a few seconds is the fallback.
  const timer = $.clock.after(5000, async () => {
    const cur = model.services.find(s => s.id === svc.id)
    if (cur && cur.status === 'starting') await patchSvc($, svc.id, { status: 'running' })
  })
  try {
    for await (const { text } of stream) {
      const clean = text.replace(ANSI, '').replace(/\r/g, '\n')
      const url = clean.match(URL_RE)?.[0]
      const cur = model.services.find(s => s.id === svc.id)
      await patchSvc($, svc.id, url && !cur?.url ? { url: url.replace(/0\.0\.0\.0|\[::1?\]/, 'localhost'), status: 'running' } : {}, clean)
    }
    const end = await stream.result.catch(() => ({ code: null as number | null, signal: null as string | null }))
    const wasStopped = stopping.has(svc.id)
    await patchSvc($, svc.id, { status: wasStopped ? 'stopped' : end.code === 0 ? 'done' : 'failed', exit: end.code ?? -1 })
  } catch {
    await patchSvc($, svc.id, { status: stopping.has(svc.id) ? 'stopped' : 'failed' })
  } finally {
    timer.cancel()
  }
}

async function askClaude($: any, why: string) {
  const tails = model.services
    .filter(s => s.status === 'failed')
    .map(s => `--- ${s.name} (\`${s.cmd}\` in ${s.cwd}) exit ${s.exit}\n${s.tail.slice(-15).join('\n')}`)
    .join('\n')
  await $.prompt.submit({
    text: `${why}\n\nGet this application running locally. Read the repo (README, package.json/pyproject/Makefile/compose files, env examples), work out the right commands, fix whatever blocks it, then write the working recipe to .claude/play.json so the play button can run it next time:\n{"setup":[{"label":"install","cmd":"...","cwd":"."}],"services":[{"name":"${model.project}-web","cmd":"...","cwd":"."}]}\nDo not start the servers yourself; the play button does that.${tails ? `\n\nLast attempt:\n${tails}` : ''}`,
  })
}

async function start($: any) {
  if (model.isBusy) return
  await publish($, { isBusy: true, msg: 'Reading the repo…' })
  const plan = await detect(fsOf($), model.cwd).catch(() => null)
  if (!plan || plan.services.length === 0) {
    await publish($, { plan, isBusy: false, msg: 'Nothing detected' })
    $.ui.toast("Couldn't tell how to run this repo. Asking Claude.")
    await askClaude($, "The play button couldn't detect how to run this repo.")
    return
  }
  await publish($, { plan, services: [], msg: '' })

  for (const step of plan.setup) {
    await publish($, { msg: `${step.label}…` })
    const dir = step.cwd.startsWith('/') ? step.cwd : `${model.cwd}/${step.cwd}`
    const r = await $.process.run(['/bin/sh', '-c', LAUNCH, 'x', pidfile('setup'), dir, step.cmd], { timeoutMs: 600000 }).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode !== 0) {
      const failed: Svc = { id: 'setup', name: step.label, cmd: step.cmd, cwd: step.cwd, status: 'failed', url: '', startedAt: 0, exit: r.exitCode, tail: (r.stderr || r.stdout).split('\n').slice(-TAIL) }
      await publish($, { services: [failed], isBusy: false, msg: `${step.label} failed` })
      return
    }
  }

  await publish($, { isBusy: false, msg: '' })
  plan.services.forEach(svc => void launch($, plan, svc))
}

async function stop($: any) {
  await publish($, { isBusy: true, msg: 'Stopping…' })
  await stopAll($)
  await publish($, { isBusy: false, msg: '' })
}


export const register: Register = on => {
  let ticker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    const cwd = e.cwd
    model = { ...EMPTY, cwd, project: base(cwd), now: await $.clock.now() }
    // A reload loses the child streams; clear what an earlier load left behind.
    await $.process.run(['/bin/sh', '-c', `for f in "${home}/.claude/play-button/pids/${hash(cwd)}"-*.pid; do [ -e "$f" ] && /bin/sh -c '${KILL.replace(/'/g, `'\\''`)}' x "$f"; done; exit 0`], { timeoutMs: 20000 }).catch(() => undefined)
    model = { ...model, plan: await detect(fsOf($), cwd).catch(() => null) }
    await $.state.set(play, model)
    await $.command.register({ name: 'play', description: 'Show the services the play button runs, with logs' })
    ticker = $.clock.every(1000, async () => {
      if (model.services.some(isLive)) {
        model = { ...model, now: await $.clock.now() }
        await $.state.set(play, model)
      }
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    await stopAll($, 3000)
    return next(e)
  })

  on('command.run', { command: 'play' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Services' })
    return { text: 'Services pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another plugin's band (the progress bar) may sit beneath ours: keep it.
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { value } = await $.state.get(play)
    const p = value ?? EMPTY
    const { Box, Text, Button } = $.ui.resolve(e)

    const live = p.services.filter(isLive)
    const isOn = live.length > 0 || p.isBusy
    const failed = p.services.filter(s => s.status === 'failed')
    const planned = p.plan?.services ?? []
    const shown = p.services.length > 0 ? p.services : planned.map(s => ({ ...s, status: 'idle', url: '', startedAt: 0, exit: -1, tail: [] as string[] }))
    const summary = live.length > 0 ? `${live.length}/${shown.length} running ` : p.isBusy ? `${p.msg} ` : planned.length > 0 ? `${planned.length} service${planned.length === 1 ? '' : 's'} ` : 'ask Claude to set up '

    const row = (
      <Box justifyContent="flex-end">
        <Box key="play" flexDirection="column" alignItems="flex-end">
          <Box display="none" hover={{ display: 'flex' }} flexDirection="column" paddingX={1}>
            <Text bold>{p.project}{p.plan ? <Text dimColor> · {p.plan.source}</Text> : null}</Text>
            {shown.map(s => (
              <Text>
                <Text color={COLOR[s.status] ?? 'gray'}>{DOT[s.status] ?? '·'} </Text>
                {s.name}
                {s.url ? <Text color="cyan"> {s.url}</Text> : null}
                {isLive(s as Svc) ? <Text dimColor> {fmt(p.now - s.startedAt)}</Text> : null}
                {s.status === 'failed' ? <Text color="red"> exit {s.exit}</Text> : null}
              </Text>
            ))}
            {p.msg ? <Text dimColor>{p.msg}</Text> : null}
            {shown.length === 0 ? <Text dimColor>Nothing detected: press ▶ and Claude works it out.</Text> : null}
          </Box>
          <Box flexDirection="row">
            {failed.length > 0 && !p.isBusy ? (
              <Button key="fix" plain label="Fix with Claude " onPress={() => void askClaude($, 'The play button started this app but something failed.')} />
            ) : null}
            {live.some(s => s.url) && !p.isBusy ? (
              <Button key="open" plain label="Open " onPress={() => void $.process.run(['open', live.find(s => s.url)!.url]).catch(() => undefined)} />
            ) : null}
            <Text dimColor>{summary}</Text>
            <Button key="toggle" variant="primary" label={isOn ? ' ‖ ' : ' ▶ '} onPress={() => void (isOn ? stop($) : start($))} />
          </Box>
        </Box>
      </Box>
    )

    const hasBelow = below !== null && typeof below === 'object' && 'type' in (below as object)
    return hasBelow ? (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    ) : (
      row
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { value } = await $.state.get(play)
    const p = value ?? EMPTY
    const { Box, Text } = $.ui.resolve(e)
    if (p.services.length === 0) return <Text dimColor>Nothing running. Press ▶ above the prompt.</Text>
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 24) - 4) / p.services.length) - 2)
    return (
      <Box flexDirection="column">
        {p.services.map(s => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>
              <Text color={COLOR[s.status] ?? 'gray'}>{DOT[s.status] ?? '·'} </Text>
              {s.name}
              <Text dimColor> {s.cmd}</Text>
            </Text>
            {s.tail.slice(-room).map(line => (
              <Text dimColor wrap="truncate-end">{line}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
