export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type DayTotal = { day: string; label: string; total: number }

// What the dashboard and the launcher draw, rebuilt from the store after
// every counted turn.
export type View = {
  lifetime: Totals
  session: Totals
  sessions: number
  since: number
  isScanning: boolean
  days: DayTotal[]
  history: { files: number; messages: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'lifetime-tokens': { view: Shaped<View | null> }
  }
}
