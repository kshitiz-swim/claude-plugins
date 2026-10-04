import type { Register } from 'claude-code'

import type { Run } from '../types'

const DEFAULT_EXPECTED_MS = 60000
const IDLE: Run = { startedAt: 0, elapsedMs: 0, isRunning: false, expectedMs: DEFAULT_EXPECTED_MS, avgTools: 0, tools: 0, pausedMs: 0, pausedAt: 0, waiting: 0 }
const run = { plugin: 'progress-bar', key: 'run' } as const
const PANE = 'progress-bar'

// Time spent waiting on the person (a permission prompt, a question) is not the
// model's time: the clock stops while any wait is open.
const pause = (r: Run, now: number): Run =>
  r.waiting === 0 ? { ...r, waiting: 1, pausedAt: now } : { ...r, waiting: r.waiting + 1 }

const resume = (r: Run, now: number): Run => {
  if (r.waiting <= 0) return r
  if (r.waiting > 1) return { ...r, waiting: r.waiting - 1 }
  return { ...r, waiting: 0, pausedMs: r.pausedMs + (now - r.pausedAt), pausedAt: 0 }
}

const resumeAll = (r: Run, now: number): Run =>
  r.waiting > 0 ? { ...r, waiting: 0, pausedMs: r.pausedMs + (now - r.pausedAt), pausedAt: 0 } : r

const active = (r: Run, now: number) => now - r.startedAt - r.pausedMs - (r.pausedAt ? now - r.pausedAt : 0)

// Tools that are the person's turn to answer, start to finish.
const ASKS = ['AskUserQuestion', 'ExitPlanMode']

const fmt = (ms: number) => {
  const s = Math.floor(Math.abs(ms) / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// Where the turn now looks like it will end. Starts at the first estimate, then
// follows the pace of tool calls against a typical turn, and never lands sooner
// than a bit past "now" - so a turn running long keeps pushing it out.
const projected = (r: Run) => {
  let total = r.expectedMs
  if (r.tools >= 2 && r.avgTools > 0) {
    total = 0.5 * r.expectedMs + 0.5 * ((r.elapsedMs * r.avgTools) / r.tools)
  }
  return r.isRunning ? Math.max(total, r.elapsedMs * 1.25) : r.elapsedMs
}

const percent = (r: Run) => (r.isRunning ? Math.min(95, Math.round((100 * r.elapsedMs) / projected(r))) : 100)

// ▲ slower than the first estimate, ▼ faster, nothing while it is on track.
const drift = (r: Run) => {
  if (r.waiting > 0) return null
  const delta = projected(r) - r.expectedMs
  if (Math.abs(delta) < Math.max(5000, 0.1 * r.expectedMs)) return null
  return delta > 0
    ? { arrow: '▲', color: 'yellow', text: `${fmt(delta)} slower than first estimate` }
    : { arrow: '▼', color: 'green', text: `${fmt(delta)} faster than first estimate` }
}

const bar = (pct: number, width: number) => {
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const detail = (r: Run) => {
  const d = drift(r)
  const eta = r.isRunning ? ` · est. ${fmt(projected(r))}` : ''
  const first = r.isRunning && d ? ` (was ${fmt(r.expectedMs)})` : ''
  if (r.isRunning && r.waiting > 0) return `⏸ waiting for you · ${fmt(r.elapsedMs)} so far (paused)`
  return `${r.isRunning ? '⏱' : '✓ done in'} ${fmt(r.elapsedMs)} · ${r.tools} tools${eta}${first}`
}

const line = (r: Run) => {
  const d = drift(r)
  return `${bar(percent(r), 16)} ${r.isRunning ? '~' : ''}${percent(r)}% ${detail(r)}${d ? ` ${d.arrow}` : ''}`
}

export const register: Register = on => {
  let cancel: (() => void) | null = null
  let surface: string | null = null
  let isPaneUp = false
  let permPending = 0

  const stop = () => {
    cancel?.()
    cancel = null
  }

  // VS Code has no band above the prompt, so it gets a pane (every surface can
  // draw one); if the pane can't be seated, a pinned status line carries it.
  on('session.start', async ($, e, next) => {
    surface = e.surface
    if (surface === 'vscode') {
      const opened = await $.ui.open({ id: PANE, title: 'Progress' })
      isPaneUp = opened.isPlaced
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const stored = Number(await $.store.get('expectedMs'))
    const avgTools = Number(await $.store.get('avgTools'))
    const expectedMs = stored > 5000 ? stored : DEFAULT_EXPECTED_MS
    const startedAt = await $.clock.now()
    await $.state.set(run, { startedAt, elapsedMs: 0, isRunning: true, expectedMs, avgTools: avgTools > 0 ? avgTools : 0, tools: 0, pausedMs: 0, pausedAt: 0, waiting: 0 })

    permPending = 0
    stop()
    const timer = $.clock.every(1000, async () => {
      const now = await $.clock.now()
      const { value } = await $.state.get(run)
      if (value && value.isRunning) {
        const tick = { ...value, elapsedMs: active(value, now) }
        await $.state.set(run, tick)
        if (surface === 'vscode' && !isPaneUp) $.ui.status(line(tick))
      }
    })
    cancel = () => timer.cancel()

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isAsk = ASKS.includes(e.tool)
    const before = await $.clock.now()
    const held = (await $.state.get(run)).value
    if (held) await $.state.set(run, { ...(isAsk ? pause(held, before) : held), tools: held.tools + 1 })

    const ran = await next(e)

    // An ask is waited on the whole way through; a permission prompt opened (see
    // classic.PermissionRequest) is over once the call comes back, allowed or denied.
    const isPrompted = !isAsk && permPending > 0
    if (isAsk || isPrompted) {
      if (isPrompted) permPending -= 1
      const now = await $.clock.now()
      const after = (await $.state.get(run)).value
      if (after) await $.state.set(run, resume(after, now))
    }
    return ran
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    permPending += 1
    const now = await $.clock.now()
    const held = (await $.state.get(run)).value
    if (held && held.isRunning) await $.state.set(run, pause(held, now))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    stop()
    const now = await $.clock.now()
    const { value } = await $.state.get(run)
    const r = resumeAll(value ?? IDLE, now)
    const elapsedMs = r.startedAt ? active(r, now) : r.elapsedMs
    // Learn: expected duration and tool count are running averages of your own turns.
    if (e.reason === 'answer' && elapsedMs > 3000) {
      await $.store.set('expectedMs', Math.round(0.7 * r.expectedMs + 0.3 * elapsedMs))
      await $.store.set('avgTools', r.avgTools > 0 ? 0.7 * r.avgTools + 0.3 * r.tools : Math.max(1, r.tools))
    }
    const done = { ...r, elapsedMs, isRunning: false }
    await $.state.set(run, done)
    if (surface === 'vscode' && !isPaneUp) $.ui.status(line(done))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Stack with other plugins' bands (the play button) instead of replacing them.
    const below = await next(e)
    const { value } = await $.state.get(run)
    const r = value ?? IDLE
    if (e.props.hasSurvey || r.startedAt === 0 || surface === 'vscode') return below

    const { Box, Text } = $.ui.resolve(e)
    const d = drift(r)

    const mine = (
      <Box>
        <Text color={r.isRunning ? 'cyan' : 'green'}>{bar(percent(r), 24)}</Text>
        <Text bold> {r.isRunning ? '~' : ''}{percent(r)}% </Text>
        <Text dimColor>{detail(r)} </Text>
        {d && <Text bold color={d.color}>{d.arrow} {d.text}</Text>}
      </Box>
    )
    const hasBelow = below !== null && typeof below === 'object' && 'type' in (below as object)
    return hasBelow ? (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { value } = await $.state.get(run)
    const r = value ?? IDLE
    const { Box, Text } = $.ui.resolve(e)
    const d = drift(r)

    if (r.startedAt === 0) return <Text dimColor>Idle. The bar starts with your next message.</Text>

    return (
      <Box flexDirection="column">
        <Text>
          <Text color={r.isRunning ? 'cyan' : 'green'}>{bar(percent(r), 24)}</Text>
          <Text bold> {r.isRunning ? '~' : ''}{percent(r)}%</Text>
        </Text>
        <Text dimColor>{detail(r)}</Text>
        {d && <Text bold color={d.color}>{d.arrow} {d.text}</Text>}
      </Box>
    )
  })
}
