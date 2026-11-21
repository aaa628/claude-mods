import { atom, update } from 'claude-code'
import type { EngineInterface, ModelUsage } from 'claude-code'

import type { DayTotal, Totals, View } from '../types'

// The counting half of the mod.
//
// Every model request's tokens are added to a per-session total and a
// per-day total kept in `$.store`, which lives in the Claude Code config
// directory and so outlives the session. The lifetime figure is the sum of
// every session's total, plus a one-time count of the history that was
// already on disk when the mod was first installed (read from the
// transcripts under `<config>/projects/`).

type Engine = EngineInterface

type SessionEntry = Totals & { updatedAt: number }
type Archive = { totals: Totals; sessions: number }
type Backfill = {
  totals: Totals
  // Requests made from this moment on are counted live, not from transcripts.
  cutoff: number
  files: number
  messages: number
}
type Seen = Map<string, { totals: Totals; at: number }>

const BACKFILL_KEY = 'backfill'
const DAYS_BACKFILL_KEY = 'daysBackfill'
const ARCHIVE_KEY = 'archive'
const SESSION_PREFIX = 'session:'
const DAY_PREFIX = 'day:'
const INSTALLED_KEY = 'installedAt'
// Every session and computer's totals, as sync.ts last read them from the
// dashboard.
export const ACCOUNT_KEY = 'account'
export type Account = {
  totals: Totals
  days: Record<string, number>
  machines: number
  since: string | null
  at: number
}

// Sessions untouched this long are folded into one archive total so the
// store stays small however many sessions there have been.
const FOLD_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const CHUNK_BYTES = 4 * 1024 * 1024
export const CHART_DAYS = 14

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const view = atom({ plugin: 'lifetime-tokens', key: 'view' } as const, null, {
  shape: 'view-2',
})

// The module's own variables start over at a reload; the counts live in
// `$.store`, so nothing is lost.
let sessionId = ''
let isScanning = false
// Store writes from this process run one at a time, so a subagent's turn
// ending beside the main one never loses an update.
let queue: Promise<unknown> = Promise.resolve()

export const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const asTotals = (value: unknown): Totals => {
  const v = (value ?? {}) as Record<string, unknown>

  return {
    input: num(v.input),
    output: num(v.output),
    cacheRead: num(v.cacheRead),
    cacheWrite: num(v.cacheWrite),
  }
}

const add = (a: Totals, b: Totals): Totals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const max = (a: Totals, b: Totals): Totals => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
})

const fromUsage = (u: ModelUsage): Totals => ({
  input: num(u.input_tokens),
  output: num(u.output_tokens),
  cacheRead: num(u.cache_read_input_tokens),
  cacheWrite: num(u.cache_creation_input_tokens),
})

export const sum = (t: Totals): number => t.input + t.output + t.cacheRead + t.cacheWrite

export const short = (n: number): string => {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`

  return String(Math.round(n))
}

export const long = (n: number): string =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const pad = (n: number): string => String(n).padStart(2, '0')

// The calendar day a moment falls on, as the store keys it.
const dayOf = (ms: number): string => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const dateLabel = (ms: number): string => {
  const d = new Date(ms)

  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}, ${d.getFullYear()}`
}

// The last CHART_DAYS days ending today, oldest first.
const lastDays = (now: number): { day: string; label: string }[] => {
  const today = new Date(now)
  const out: { day: string; label: string }[] = []
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    out.push({ day: dayOf(d.getTime()), label: `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}` })
  }

  return out
}

const parentOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut <= 0 ? path : path.slice(0, cut)
}

const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)

  return run
}

// Adds one transcript row's usage to `seen`, keyed by the response's id:
// each response is written as several rows repeating the same usage, and
// resumed or forked sessions copy earlier rows, so every response counts once.
const scanLine = (line: string, fallbackId: string, cutoff: number, seen: Seen) => {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  let row: {
    type?: unknown
    timestamp?: unknown
    message?: { id?: unknown; usage?: Record<string, unknown> }
  }
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (row.type !== 'assistant') return
  const u = row.message?.usage
  if (!u) return
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
  if (at >= cutoff) return
  const id = typeof row.message?.id === 'string' ? row.message.id : fallbackId
  const totals = asTotals({
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  })
  const prev = seen.get(id)
  seen.set(id, {
    totals: prev === undefined ? totals : max(prev.totals, totals),
    at: Number.isNaN(at) ? (prev?.at ?? Number.NaN) : at,
  })
}

async function currentId($: Engine): Promise<string> {
  if (sessionId === '') sessionId = await $.session.id()

  return sessionId
}

async function scanFile(
  $: Engine,
  path: string,
  size: number,
  cutoff: number,
  seen: Seen,
): Promise<void> {
  let carry = ''
  let lineNo = 0
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, size - offset)
    const text = await $.fs.read(path, { offset, length })
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) scanLine(line, `${path}:${lineNo++}`, cutoff, seen)
  }
  if (carry !== '') scanLine(carry, `${path}:${lineNo}`, cutoff, seen)
}

// Every .jsonl under `dir`, `depth` folders down: a project's
// `<session>.jsonl`, and its subagents' `<session>/subagents/<agent>.jsonl`.
async function scanDir(
  $: Engine,
  dir: string,
  depth: number,
  cutoff: number,
  seen: Seen,
): Promise<number> {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const entries = await $.fs.list(dir).catch(() => [])
  let files = 0
  for (const entry of entries) {
    const path = `${dir}${sep}${entry.name}`
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
      const isRead = await scanFile($, path, entry.size, cutoff, seen).then(
        () => true,
        () => false,
      )
      if (isRead) files += 1
    } else if (entry.kind === 'dir' && depth > 0 && entry.name !== 'tool-results') {
      files += await scanDir($, path, depth - 1, cutoff, seen)
    }
  }

  return files
}

async function readView($: Engine): Promise<View> {
  const id = await currentId($)
  const now = await $.clock.now()
  const chart = lastDays(now)
  const wanted = new Set(chart.map(d => DAY_PREFIX + d.day))
  const byDay = new Map<string, number>()
  let lifetime = zero()
  let session = zero()
  let sessions = 0

  for (const key of await $.store.keys()) {
    if (key === BACKFILL_KEY) {
      const b = (await $.store.get(key)) as Partial<Backfill> | undefined
      lifetime = add(lifetime, asTotals(b?.totals))
    } else if (key === ARCHIVE_KEY) {
      const a = (await $.store.get(key)) as Partial<Archive> | undefined
      lifetime = add(lifetime, asTotals(a?.totals))
      sessions += num(a?.sessions)
    } else if (key.startsWith(SESSION_PREFIX)) {
      const t = asTotals(await $.store.get(key))
      lifetime = add(lifetime, t)
      sessions += 1
      if (key === SESSION_PREFIX + id) session = t
    } else if (wanted.has(key)) {
      byDay.set(key.slice(DAY_PREFIX.length), sum(asTotals(await $.store.get(key))))
    }
  }

  const backfill = (await $.store.get(BACKFILL_KEY)) as Backfill | undefined
  const history = backfill === undefined ? null : { files: backfill.files, messages: backfill.messages }
  const account = (await $.store.get(ACCOUNT_KEY)) as Partial<Account> | undefined

  // The dashboard's rows, once read, are the whole account: this machine's
  // rows among them, as of the last sync.
  if (account?.totals !== undefined) {
    const since = typeof account.since === 'string' ? Date.parse(`${account.since}T12:00:00`) : Number.NaN

    return {
      lifetime: asTotals(account.totals),
      session,
      sessions: num(account.machines),
      since: Number.isNaN(since) ? num(await $.store.get(INSTALLED_KEY)) : since,
      isScanning: false,
      isAccount: true,
      days: chart.map(d => ({ ...d, total: num(account.days?.[d.day]) })),
      history,
    }
  }

  return {
    lifetime,
    session,
    sessions,
    since: num(await $.store.get(INSTALLED_KEY)),
    isScanning: backfill === undefined,
    isAccount: false,
    days: chart.map(d => ({ ...d, total: byDay.get(d.day) ?? 0 })),
    history,
  }
}

// Rebuilds what the dashboard, the launcher and the status line show.
export async function refresh($: Engine): Promise<View> {
  const next = await readView($)
  await update($, view, () => next)
  const scanning = next.isScanning ? ' (reading past sessions…)' : ''
  $.ui.status(
    `Lifetime tokens: ${short(sum(next.lifetime))}${scanning} · this session: ${short(sum(next.session))}`,
  )

  return next
}

export async function addUsage($: Engine, usage: ModelUsage): Promise<void> {
  const sessionKey = SESSION_PREFIX + (await currentId($))
  const now = await $.clock.now()
  const dayKey = DAY_PREFIX + dayOf(now)
  const added = fromUsage(usage)
  await serial(async () => {
    const entry: SessionEntry = {
      ...add(asTotals(await $.store.get(sessionKey)), added),
      updatedAt: now,
    }
    await $.store.set(sessionKey, entry)
    await $.store.set(dayKey, add(asTotals(await $.store.get(dayKey)), added))
  })
  await refresh($)
}

// Folds sessions nobody has touched in a while into the archive total.
async function foldOld($: Engine): Promise<void> {
  const now = await $.clock.now()
  const own = SESSION_PREFIX + (await currentId($))
  await serial(async () => {
    const archive = (await $.store.get(ARCHIVE_KEY)) as Partial<Archive> | undefined
    let totals = asTotals(archive?.totals)
    let sessions = num(archive?.sessions)
    const stale: string[] = []

    for (const key of await $.store.keys()) {
      if (!key.startsWith(SESSION_PREFIX) || key === own) continue
      const entry = (await $.store.get(key)) as Partial<SessionEntry> | undefined
      if (now - num(entry?.updatedAt) < FOLD_AFTER_MS) continue
      totals = add(totals, asTotals(entry))
      sessions += 1
      stale.push(key)
    }

    if (stale.length === 0) return
    const next: Archive = { totals, sessions }
    await $.store.set(ARCHIVE_KEY, next)
    for (const key of stale) await $.store.delete(key)
  })
}

// One read of every transcript already on disk, so the count starts from
// your real history rather than from zero: the lifetime total on the first
// install, and the per-day totals the chart draws on the first version that
// keeps them. Both take only what was written before `cutoff`, from which on
// they are counted live.
async function scanHistory(
  $: Engine,
  cutoff: number,
  needsLifetime: boolean,
  needsDays: boolean,
): Promise<void> {
  if (isScanning) return
  isScanning = true

  try {
    const { transcriptPath } = await $.session.info()
    const seen: Seen = new Map()
    // <config>/projects/<project>/<session>.jsonl
    const files =
      transcriptPath === ''
        ? 0
        : await scanDir($, parentOf(parentOf(transcriptPath)), 3, cutoff, seen)

    await serial(async () => {
      if (needsLifetime && (await $.store.get(BACKFILL_KEY)) === undefined) {
        let totals = zero()
        for (const { totals: t } of seen.values()) totals = add(totals, t)
        const result: Backfill = { totals, cutoff, files, messages: seen.size }
        await $.store.set(BACKFILL_KEY, result)
      }

      if (needsDays && (await $.store.get(DAYS_BACKFILL_KEY)) === undefined) {
        const byDay = new Map<string, Totals>()
        for (const { totals, at } of seen.values()) {
          if (Number.isNaN(at)) continue
          const day = dayOf(at)
          byDay.set(day, add(byDay.get(day) ?? zero(), totals))
        }
        for (const [day, totals] of byDay) {
          const key = DAY_PREFIX + day
          await $.store.set(key, add(asTotals(await $.store.get(key)), totals))
        }
        await $.store.set(DAYS_BACKFILL_KEY, { cutoff })
      }
    })
  } finally {
    isScanning = false
  }
  await refresh($)
}

export async function start($: Engine): Promise<void> {
  sessionId = await $.session.id()
  const now = await $.clock.now()

  if ((await $.store.get(INSTALLED_KEY)) === undefined) {
    await $.store.set(INSTALLED_KEY, now)
  }
  await foldOld($)
  await refresh($)

  const needsLifetime = (await $.store.get(BACKFILL_KEY)) === undefined
  const needsDays = (await $.store.get(DAYS_BACKFILL_KEY)) === undefined
  if (needsLifetime || needsDays) {
    // Off the start path: the session is usable while history is read.
    $.clock.after(0, () => {
      void scanHistory($, now, needsLifetime, needsDays).catch(() => refresh($))
    })
  }
}

export async function report($: Engine): Promise<string> {
  const v = await readView($)
  const rows: [string, number][] = [
    ['Total', sum(v.lifetime)],
    ['Input', v.lifetime.input],
    ['Output', v.lifetime.output],
    ['Cache writes', v.lifetime.cacheWrite],
    ['Cache reads', v.lifetime.cacheRead],
  ]
  const width = Math.max(...rows.map(([, n]) => long(n).length))
  const table = rows
    .map(([label, n]) => `  ${label.padEnd(13)} ${long(n).padStart(width)}`)
    .join('\n')

  const since = v.since > 0 ? new Date(v.since).toISOString().slice(0, 10) : 'this session'
  const history =
    v.history === null
      ? 'Still reading the transcripts of past sessions; run /tokens again in a moment.'
      : `Before that, ${long(v.history.files)} transcript files ` +
        `(${long(v.history.messages)} responses) already on this machine were counted.`

  // The daily chart as one line of text, for wherever the dashboard cannot
  // be drawn (a headless session, a remote app that draws no mod UI).
  const peak = Math.max(0, ...v.days.map(d => d.total))
  const bars = v.days
    .map(d => (d.total <= 0 || peak <= 0 ? '·' : SPARK[Math.min(7, Math.floor((d.total / peak) * 7))]))
    .join(' ')

  return [
    v.isAccount
      ? 'Lifetime token usage, every session and computer on your account'
      : 'Lifetime token usage, every session on this machine',
    table,
    '',
    `  Last 14 days  ${bars}   (${v.days[0]?.label ?? ''} → today, peak ${short(peak)}/day)`,
    '',
    `This session: ${long(sum(v.session))} ` +
      `(input ${short(v.session.input)}, output ${short(v.session.output)}, ` +
      `cache writes ${short(v.session.cacheWrite)}, cache reads ${short(v.session.cacheRead)})`,
    v.isAccount
      ? `Since ${since}, across ${long(v.sessions)} sessions and computers.`
      : `Counted live since ${since} across ${long(v.sessions)} sessions. ${history}`,
  ].join('\n')
}
