export type Svc = {
  id: string
  name: string
  cmd: string
  cwd: string
  /** starting | running | failed | stopped | done */
  status: string
  url: string
  startedAt: number
  /** Exit code once it has ended, -1 otherwise. */
  exit: number
  tail: string[]
}

export type Plan = {
  /** Where the plan came from: override, Procfile, package.json, compose, ... */
  source: string
  setup: { label: string; cmd: string; cwd: string }[]
  services: { id: string; name: string; cmd: string; cwd: string }[]
}

export type Play = {
  cwd: string
  project: string
  plan: Plan | null
  services: Svc[]
  /** Short status line: installing deps, nothing detected, ... */
  msg: string
  isBusy: boolean
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'play-button': { play: Play }
  }
}
