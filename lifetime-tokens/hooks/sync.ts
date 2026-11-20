import type { EngineInterface } from 'claude-code'

// Copies this machine's daily totals to the Lifetime Tokens dashboard, a
// page on your Claude account, so that every session counts toward one
// total wherever it runs: a cloud session's machine is gone when it ends,
// and the app draws no mod UI there, but the dashboard keeps every row and
// opens from any session.
//
// One row per machine and day, `<machine>_<day>`, holding that day's totals
// on that machine (the same figures the local chart draws). A machine is
// named by the session it was set up in, so a cloud session resumed on a
// new machine writes the same rows again rather than new ones.

type Engine = EngineInterface
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Synced = Record<string, { total: number; version: number }>

export const DASHBOARD_URL = 'https://claude.ai/artifact/RnUUpa8gmREw3RPmN293Bu'
const ROWS = 'data/usage/rows'
const MACHINE_KEY = 'machine'
const SYNCED_KEY = 'synced'
const DAY_PREFIX = 'day:'
const BATCH = 50

let isSyncing = false
let isPending = false
// Whether this copy of the module has read the dashboard's versions of its
// own rows; a write to a row that exists must name its version.
let knowsRemote = false

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const totalsOf = (value: unknown): Totals => {
  const v = (value ?? {}) as Record<string, unknown>

  return {
    input: num(v.input),
    output: num(v.output),
    cacheRead: num(v.cacheRead),
    cacheWrite: num(v.cacheWrite),
  }
}

const sum = (t: Totals): number => t.input + t.output + t.cacheRead + t.cacheWrite

// The JSON documents between a read's BEGIN and END lines.
export const parseRows = (text: string): { id: string; version: number }[] => {
  const out: { id: string; version: number }[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const doc = JSON.parse(line) as { id?: unknown; version?: unknown }
      if (typeof doc.id === 'string' && typeof doc.version === 'number') {
        out.push({ id: doc.id, version: doc.version })
      }
    } catch {
      // not a document line
    }
  }

  return out
}

// `- set "data/usage/rows"/"<id>" (version N)` for each write that landed.
export const parseWritten = (text: string): Map<string, number> => {
  const out = new Map<string, number>()
  for (const m of text.matchAll(/- set "[^"]*"\/"([^"]+)" \(version (\d+)\)/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], Number(m[2]))
  }

  return out
}

async function machineId($: Engine): Promise<string> {
  const stored = await $.store.get(MACHINE_KEY)
  if (typeof stored === 'string' && stored !== '') return stored
  const id = (await $.session.id()).replace(/[^A-Za-z0-9_\-.~:@+]/g, '-')
  await $.store.set(MACHINE_KEY, id)

  return id
}

// Learns the version of each row this machine already has on the dashboard.
async function readRemote($: Engine, machine: string, synced: Synced): Promise<boolean> {
  const read = await $.tool.call({
    tool: 'ArtifactData',
    action: 'query',
    url: DASHBOARD_URL,
    collection: ROWS,
    query: { where: [['machine', '==', machine]], limit: 1000 },
  })
  if (read.deny !== undefined || read.isError) return false
  for (const row of parseRows(read.text ?? '')) {
    synced[row.id] = { total: synced[row.id]?.total ?? -1, version: row.version }
  }

  return true
}

async function syncOnce($: Engine): Promise<void> {
  const machine = await machineId($)
  const synced: Synced = { ...((await $.store.get(SYNCED_KEY)) as Synced | undefined) }
  const now = new Date(await $.clock.now()).toISOString()

  const changed: { id: string; day: string; totals: Totals }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(DAY_PREFIX)) continue
    const day = key.slice(DAY_PREFIX.length)
    const totals = totalsOf(await $.store.get(key))
    const id = `${machine}_${day}`
    if (synced[id]?.total !== sum(totals)) changed.push({ id, day, totals })
  }
  if (changed.length === 0) return

  if (!knowsRemote) {
    if (!(await readRemote($, machine, synced))) return
    knowsRemote = true
  }

  for (let i = 0; i < changed.length; i += BATCH) {
    const chunk = changed.slice(i, i + BATCH)
    const writes = chunk.map(({ id, day, totals }) => {
      const version = synced[id]?.version

      return {
        op: 'set' as const,
        collection: ROWS,
        doc_id: id,
        data: { machine, day, ...totals, total: sum(totals), updatedAt: now },
        ...(version !== undefined && version > 0 ? { if_version: version } : {}),
      }
    })
    const wrote = await $.tool.call({
      tool: 'ArtifactData',
      action: 'batch',
      url: DASHBOARD_URL,
      writes,
    })
    if (wrote.deny !== undefined || wrote.isError) {
      // Someone else wrote one of these rows since: read the versions again
      // at the next sync.
      knowsRemote = false
      break
    }
    const versions = parseWritten(wrote.text ?? '')
    for (const { id, totals } of chunk) {
      const version = versions.get(id)
      if (version !== undefined) synced[id] = { total: sum(totals), version }
    }
  }

  await $.store.set(SYNCED_KEY, synced)
}

// Sends what changed since the last sync. Never throws, never runs twice at
// once: a call that arrives mid-sync runs once more after it.
export async function sync($: Engine): Promise<void> {
  if (isSyncing) {
    isPending = true

    return
  }
  isSyncing = true
  try {
    do {
      isPending = false
      await syncOnce($).catch(() => undefined)
    } while (isPending)
  } finally {
    isSyncing = false
  }
}
