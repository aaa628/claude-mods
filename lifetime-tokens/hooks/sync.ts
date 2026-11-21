import type { EngineInterface } from 'claude-code'

import { ACCOUNT_KEY, refresh } from './count'
import type { Account } from './count'

// Copies this machine's daily totals to the Lifetime Tokens dashboard, a
// page on your Claude account, and reads every row back, so each session
// shows one total for the whole account wherever it runs: a cloud session's
// machine is gone when it ends, but the dashboard keeps every row.
//
// One row per machine and day, `<machine>_<day>`, holding that day's totals
// on that machine (the same figures the local chart draws). A cloud session
// is named by its cloud id, `cloud-<id>`, so the same session on a new
// machine writes the same rows again, and a row added for it from its
// record before it ran the mod is replaced rather than counted twice.
// Anywhere else a machine is named by the session it was set up in.

type Engine = EngineInterface
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Synced = Record<string, { total: number; version: number }>
type Row = { id: string; version: number; data: Record<string, unknown> }

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

const add = (a: Totals, b: Totals): Totals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// The JSON documents between a read's BEGIN and END lines.
export const parseRows = (text: string): Row[] => {
  const out: Row[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const doc = JSON.parse(line) as { id?: unknown; version?: unknown; data?: unknown }
      if (typeof doc.id === 'string' && typeof doc.version === 'number') {
        const data = typeof doc.data === 'object' && doc.data !== null ? doc.data : {}
        out.push({ id: doc.id, version: doc.version, data: data as Record<string, unknown> })
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

const clean = (id: string): string => id.replace(/[^A-Za-z0-9_\-.~:@+]/g, '-')

// This machine's name now, and the one an earlier version stored, if any.
async function machineIds($: Engine): Promise<{ id: string; stored: string | undefined }> {
  const raw = await $.store.get(MACHINE_KEY)
  const stored = typeof raw === 'string' && raw !== '' ? raw : undefined
  const cloud = await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')
  if (cloud !== undefined && cloud !== '') {
    return { id: clean(`cloud-${cloud.replace(/^[a-z]+_/, '')}`), stored }
  }

  return { id: stored ?? clean(await $.session.id()), stored }
}

async function query($: Engine, where?: [string, '==', string]): Promise<Row[] | undefined> {
  const read = await $.tool.call({
    tool: 'ArtifactData',
    action: 'query',
    url: DASHBOARD_URL,
    collection: ROWS,
    query: where === undefined ? { limit: 1000 } : { where: [where], limit: 1000 },
  })
  if (read.deny !== undefined || read.isError) return undefined

  return parseRows(read.text ?? '')
}

// Removes the rows this machine wrote under an earlier name, which the rows
// under its name now replace.
async function retire($: Engine, old: string): Promise<boolean> {
  const rows = await query($, ['machine', '==', old])
  if (rows === undefined) return false
  for (let i = 0; i < rows.length; i += BATCH) {
    const writes = rows.slice(i, i + BATCH).map(row => ({
      op: 'delete' as const,
      collection: ROWS,
      doc_id: row.id,
      if_version: row.version,
    }))
    const done = await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: DASHBOARD_URL, writes })
    if (done.deny !== undefined || done.isError) return false
  }

  return true
}

// Adds up every row on the dashboard: the whole account's totals by day.
async function readAccount($: Engine): Promise<void> {
  const rows = await query($)
  if (rows === undefined) return
  let totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const days: Record<string, number> = {}
  const machines = new Set<string>()
  let since: string | null = null
  for (const { data } of rows) {
    const t = totalsOf(data)
    totals = add(totals, t)
    const day = typeof data.day === 'string' ? data.day : ''
    if (day !== '') {
      days[day] = (days[day] ?? 0) + sum(t)
      if (since === null || day < since) since = day
    }
    if (typeof data.machine === 'string') machines.add(data.machine)
  }
  const account: Account = { totals, days, machines: machines.size, since, at: await $.clock.now() }
  await $.store.set(ACCOUNT_KEY, account)
}

async function syncOnce($: Engine): Promise<void> {
  const { id: machine, stored } = await machineIds($)
  if (stored !== machine) {
    if (stored !== undefined && !(await retire($, stored))) return
    await $.store.set(MACHINE_KEY, machine)
    await $.store.set(SYNCED_KEY, {})
    knowsRemote = false
  }

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

  if (changed.length > 0 && !knowsRemote) {
    const mine = await query($, ['machine', '==', machine])
    if (mine === undefined) return
    for (const row of mine) {
      synced[row.id] = { total: synced[row.id]?.total ?? -1, version: row.version }
    }
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
  if (changed.length > 0) await $.store.set(SYNCED_KEY, synced)

  // Other sessions and computers add rows too: read them all every time.
  await readAccount($)
  await refresh($)
}

// Sends what changed since the last sync and reads the account back. Never
// throws, never runs twice at once: a call that arrives mid-sync runs once
// more after it.
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
