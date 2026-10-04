export type Run = {
  startedAt: number
  elapsedMs: number
  isRunning: boolean
  /** The first estimate, fixed when the turn starts. */
  expectedMs: number
  /** Typical tool calls per turn, learned from past turns (0 = unknown). */
  avgTools: number
  tools: number
  /** Time spent waiting on the person (prompts, questions), not counted. */
  pausedMs: number
  /** When the current wait began; 0 when not waiting. */
  pausedAt: number
  /** Open waits (a count, since tool calls can overlap). */
  waiting: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { run: Run }
  }
}
