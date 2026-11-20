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
const world = (on: On) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    // An earlier session, recent enough to keep its own entry.
    'session:old': {
      input: 100,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      updatedAt: NOW - DAY,
    },
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
