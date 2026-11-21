import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model: 'claude-test',
})

// Two transcript rows of one response (same id, same usage), one other
// response, and one row written after the cutoff, which is counted live.
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - DAY).toISOString(),
    message: { id: 'msg_a', usage: usage(10, 20, 300, 40) },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - DAY).toISOString(),
    message: { id: 'msg_a', usage: usage(10, 20, 300, 40) },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - DAY).toISOString(),
    message: { id: 'msg_b', usage: usage(1, 2, 3, 4) },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW + DAY).toISOString(),
    message: { id: 'msg_c', usage: usage(1000, 1000, 1000, 1000) },
  }),
].join('\n')

// What lies beneath the plugin in a session with one earlier session in the
// store and one transcript on disk: the test stands for the engine.
const world = (
  on: On,
  env: Record<string, string> = {},
  stored: Record<string, unknown> = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  mock.store(on, {
    // An earlier session, recent enough to keep its own entry.
    'session:old': {
      input: 100,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      updatedAt: NOW - DAY,
    },
    ...stored,
  })

  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  on('session.id', () => ({ value: 'current' }))
  on('session.info', () => ({
    value: { transcriptPath: '/home/me/.claude/projects/-proj/current.jsonl' },
  }))
  on('fs.list', (_, e) =>
    e.path === '/home/me/.claude/projects'
      ? { value: [{ name: '-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : e.path === '/home/me/.claude/projects/-proj'
        ? {
            value: [
              {
                name: 'current.jsonl',
                kind: 'file',
                size: TRANSCRIPT.length,
                mtimeMs: 0,
                isLink: false,
              },
            ],
          }
        : { value: [] },
  )
  on('fs.read', () => ({ value: TRANSCRIPT }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))

  return { clock, statuses, opened }
}

const TURN = {
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
  usage: usage(1000, 2000, 500_000, 7000),
} as const

test('counts history once, then every turn, across sessions', async ($, on) => {
  const { clock, statuses, opened } = world(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  // History: msg_a once (370) + msg_b (10); msg_c is after the cutoff.
  // Earlier session: 300. Lifetime so far 680.
  expect(statuses.at(-1)).toBe('Lifetime tokens: 680 · this session: 0')

  await $.turn.complete(TURN)
  // A subagent's turn counts too.
  await $.turn.complete({
    answer: 'report',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    agentId: 'agent-1',
    reason: 'answer',
    usage: usage(5, 5, 0, 0),
  })

  expect(statuses.at(-1)).toBe('Lifetime tokens: 510.7K · this session: 510.0K')

  const out = await $.command.run({
    command: 'tokens',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(out.text).toContain('Total         510,690')
  expect(out.text).toContain('Output          2,227')
  expect(out.text).toContain('This session: 510,010')
  expect(out.text).toContain('1 transcript files (2 responses)')
  expect(opened).toEqual(['lifetime-tokens'])
})

const PANE = {
  plugin: 'lifetime-tokens',
  component: 'Pane',
  requestId: 'lifetime-tokens',
  props: {
    title: 'Lifetime tokens',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the dashboard draws on every surface', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'LIFETIME TOKENS' })).toBeDefined()
    // 680 before, 510,000 this turn.
    expect((await ui.find({ type: 'Text', text: '510.7K' }))?.text).toBe('510.7K')
    expect(await ui.find({ type: 'Text', text: /Cache reads/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'LAST 14 DAYS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pages/ })).toBeDefined()
    const charts = await ui.findAll({ type: 'Svg' })
    expect(charts.length).toBe(surface === 'terminal' ? 0 : 2)
    for (const chart of charts) {
      expect(String(chart.props.source)).toContain('<svg')
      expect(String(chart.props.alt).length).toBeGreaterThan(10)
    }
    await ui.unmount()
  }

  // Minimized on the desktop app: the headline alone.
  const widget = await $.ui.mount({
    ...PANE,
    surface: 'desktop',
    props: { ...PANE.props, placement: 'widget' },
  })
  expect((await widget.find({ type: 'Text', text: '510.7K' }))?.text).toBe('510.7K')
  expect(await widget.find({ type: 'Svg' })).toBeUndefined()
  await widget.unmount()
})

test('the launcher sits by the prompt and opens the dashboard', async ($, on) => {
  const { clock, opened } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'lifetime-tokens',
      surface,
      component: 'SessionMode',
      props: { modes: ['auto'] },
    })
    const button = await ui.find({ key: 'lifetime-tokens-open' })
    expect(button?.props.label).toBe('◈ 680')
    await ui.press({ key: 'lifetime-tokens-open' })
    await ui.unmount()
  }
  expect(opened).toEqual(['lifetime-tokens', 'lifetime-tokens'])

  // On the phone it goes on the hint line; elsewhere the hint line is left be.
  const hint = { isDraft: false, isWorking: false, hint: '? for shortcuts' }
  const phone = await $.ui.mount({
    plugin: 'lifetime-tokens',
    surface: 'mobile',
    component: 'PromptHint',
    props: hint,
  })
  expect(await phone.find({ key: 'lifetime-tokens-open' })).toBeDefined()
  await phone.unmount()

  const desk = await $.ui.mount({
    plugin: 'lifetime-tokens',
    surface: 'desktop',
    component: 'PromptHint',
    props: hint,
  })
  expect(await desk.find({ key: 'lifetime-tokens-open' })).toBeUndefined()
  await desk.unmount()
})

test('sessions idle for two weeks fold into the archive', async ($, on) => {
  mock.clock(on, { now: NOW })
  // The store, kept here so the test can look inside it.
  const store = new Map<string, unknown>(
    Object.entries({
      backfill: {
        totals: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        cutoff: 0,
        files: 0,
        messages: 0,
      },
      installedAt: NOW - 30 * DAY,
      'session:stale': {
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        updatedAt: NOW - 20 * DAY,
      },
      'session:fresh': {
        input: 5,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        updatedAt: NOW - DAY,
      },
    }),
  )
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))

  const statuses: (string | undefined)[] = []
  on('session.id', () => ({ value: 'current' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(store.has('session:stale')).toBe(false)
  expect(store.has('session:fresh')).toBe(true)
  expect(store.get('archive')).toEqual({
    totals: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0 },
    sessions: 1,
  })
  // 4 + 100 + 10: nothing lost in the fold.
  expect(statuses.at(-1)).toBe('Lifetime tokens: 114 · this session: 0')
})

type Write = {
  op: string
  doc_id: string
  data?: { total: number; machine: string }
  if_version?: number
}
type Query = { where?: [string, string, string][]; limit: number }

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const doc = (id: string, version: number, data: Record<string, unknown>) =>
  JSON.stringify({ id, version, data })

// The dashboard: rows by id, answering queries and batches as ArtifactData does.
const dashboard = (on: On, seed: Record<string, Record<string, unknown>> = {}) => {
  const rows = new Map(Object.entries(seed).map(([id, data]) => [id, { version: 1, data }]))
  const queries: Query[] = []
  const batches: Write[][] = []
  on('tool.call', (_, e) => {
    const input = e as unknown as { tool: string; action: string; query: Query; writes?: Write[] }
    expect(input.tool).toBe('ArtifactData')
    if (input.action === 'query') {
      queries.push(input.query)
      const machine = input.query.where?.[0]?.[2]
      const found = [...rows].filter(([, r]) => machine === undefined || r.data.machine === machine)
      const lines = found.map(([id, r]) => doc(id, r.version, r.data))

      return { result: {}, text: `=== BEGIN ===\n${lines.join('\n')}\n=== END ===` }
    }
    const writes = input.writes ?? []
    batches.push(writes)
    for (const w of writes) {
      const had = rows.get(w.doc_id)
      if (had !== undefined && w.if_version !== had.version) {
        return { result: {}, text: 'version_mismatch', isError: true }
      }
    }
    const lines = writes.map(w => {
      if (w.op === 'delete') {
        rows.delete(w.doc_id)

        return `- delete "data/usage/rows"/"${w.doc_id}"`
      }
      const version = (rows.get(w.doc_id)?.version ?? 0) + 1
      rows.set(w.doc_id, { version, data: w.data ?? {} })

      return `- set "data/usage/rows"/"${w.doc_id}" (version ${version})`
    })

    return { result: {}, text: lines.join('\n') }
  })

  return { rows, queries, batches }
}

test('copies day totals to the dashboard, pinned to the versions it read', async ($, on) => {
  const { clock } = world(on)
  const today = `current_${dayOf(NOW)}`
  const yesterday = `current_${dayOf(NOW - DAY)}`
  // Today's row is already there, from this machine's earlier run.
  const { rows, queries, batches } = dashboard(on, {
    [today]: { machine: 'current', day: dayOf(NOW), input: 1 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(60_000)

  // History from the transcript: yesterday's 380, as a new row.
  expect(rows.get(yesterday)?.data.total).toBe(380)
  expect(batches.flat().find(w => w.doc_id === yesterday)?.if_version).toBeUndefined()

  await $.turn.complete(TURN)
  await clock.settle()
  const second = batches.at(-1) ?? []
  expect(second.map(w => w.doc_id)).toEqual([today])
  expect(second[0]?.data?.total).toBe(510_000)
  // Pinned to the version it read.
  expect(second[0]?.if_version).toBe(1)

  await $.turn.complete({ ...TURN, turnId: 't2', usage: usage(1, 1, 1, 1) })
  await clock.settle()
  expect(rows.get(today)?.data.total).toBe(510_004)
  // Its own machine's rows were read once; the account after every sync.
  expect(queries.filter(q => q.where !== undefined).length).toBe(1)
  expect(queries.filter(q => q.where === undefined).length).toBeGreaterThan(1)
})

test('a cloud session counts the whole account and renames its old rows', async ($, on) => {
  const { clock, statuses } = world(
    on,
    { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_ABC123' },
    // An earlier version named this machine by its local session id.
    { machine: 'current' },
  )
  const { rows } = dashboard(on, {
    [`current_${dayOf(NOW - 2 * DAY)}`]: { machine: 'current', day: dayOf(NOW - 2 * DAY), input: 7 },
    // Another session's row: counted, never touched.
    [`cloud-OTHER_${dayOf(NOW)}`]: { machine: 'cloud-OTHER', day: dayOf(NOW), input: 1_000_000 },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(60_000)

  const ids = [...rows.keys()].sort()
  expect(ids).toEqual([`cloud-ABC123_${dayOf(NOW - DAY)}`, `cloud-OTHER_${dayOf(NOW)}`])
  expect(rows.get(`cloud-ABC123_${dayOf(NOW - DAY)}`)?.data.machine).toBe('cloud-ABC123')

  // 380 of this machine's history plus the other session's million.
  expect(statuses.at(-1)).toBe('Lifetime tokens: 1.00M · this session: 0')

  const out = await $.command.run({
    command: 'tokens',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(out.text).toContain('every session and computer on your account')
  expect(out.text).toContain('Total         1,000,380')
  expect(out.text).toContain('across 2 sessions and computers')
})
