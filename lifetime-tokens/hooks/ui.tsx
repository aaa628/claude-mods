import { atom, read } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { DayTotal, Totals, View } from '../types'
import { dateLabel, long, short, sum } from './count'

// The drawing half of the mod: the dashboard pane and its launcher.

type Engine = EngineInterface

// What count.ts writes after every counted turn; read here while drawing.
const view = atom({ plugin: 'lifetime-tokens', key: 'view' } as const, null, {
  shape: 'view-1',
})

export const PANE = 'lifetime-tokens'
export const PANE_TITLE = 'Lifetime tokens'

// Categorical slots 1-4 of the reference palette, in its fixed order, light
// and dark steps (validated as a set: adjacent CVD ΔE ≥ 8.4 in both modes).
// The light steps of slots 3 and 4 sit under 3:1 on a light surface, so the
// legend always carries each kind's name and number beside its swatch.
const KINDS = [
  { key: 'input', name: 'Input', light: '#2a78d6', dark: '#3987e5' },
  { key: 'output', name: 'Output', light: '#eb6834', dark: '#d95926' },
  { key: 'cacheWrite', name: 'Cache writes', light: '#1baf7a', dark: '#199e70' },
  { key: 'cacheRead', name: 'Cache reads', light: '#eda100', dark: '#c98500' },
] as const

const STYLE = [
  '<style>',
  '.s1{fill:#2a78d6}.s2{fill:#eb6834}.s3{fill:#1baf7a}.s4{fill:#eda100}',
  '.grid{stroke:#e1e0d9;stroke-width:1}.base{stroke:#c3c2b7;stroke-width:1}',
  '.track{fill:#e1e0d9}.hit{fill:transparent}',
  '.lbl{fill:#898781;font:11px system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.bar:hover .m{opacity:.75}.seg:hover{opacity:.8}',
  '@media (prefers-color-scheme: dark){',
  '.s1{fill:#3987e5}.s2{fill:#d95926}.s3{fill:#199e70}.s4{fill:#c98500}',
  '.grid{stroke:#2c2c2a}.base{stroke:#383835}.track{fill:#2c2c2a}}',
  '</style>',
].join('')

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const pct = (part: number, whole: number): string => {
  if (whole <= 0 || part <= 0) return '0%'
  const p = (part / whole) * 100

  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

// A round number at or above `n` for the chart's top gridline.
const niceMax = (n: number): number => {
  if (n <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(n))
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => s * mag >= n) ?? 10

  return step * mag
}

// An axis figure: `6M`, `1.5K`, never `6.00M`.
const axis = (n: number): string => short(n).replace(/\.0+(?=[KMBT]$)/, '').replace(/(\.\d*?)0+(?=[KMBT]$)/, '$1')

// The chart's width in CSS pixels, from the room the pane has.
const pixels = (columns: number): number => Math.max(260, Math.min(720, columns * 8))

// Segment widths in proportion, each nonzero kind at least `min` wide so it
// stays visible (its exact share is in the legend beside it).
const segments = (values: number[], width: number, gap: number, min: number): number[] => {
  const shown = values.filter(v => v > 0).length
  const room = width - gap * Math.max(0, shown - 1)
  const total = values.reduce((a, b) => a + b, 0)
  const raw = values.map(v => (v > 0 ? (v / total) * room : 0))
  const small = raw.filter(w => w > 0 && w < min)
  const squeezed = room - small.length * min
  const large = raw.filter(w => w >= min).reduce((a, b) => a + b, 0)

  return raw.map(w => (w === 0 ? 0 : w < min ? min : (w / large) * squeezed))
}

export const compositionSvg = (t: Totals, width: number): string => {
  const h = 14
  const total = sum(t)
  const values = KINDS.map(k => t[k.key])
  const widths = segments(values, width, 2, 3)
  let x = 0
  const parts = KINDS.map((k, i) => {
    const w = widths[i] ?? 0
    if (w <= 0) return ''
    const part =
      `<rect class="seg s${i + 1}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${h}">` +
      `<title>${esc(`${k.name}: ${long(values[i] ?? 0)} (${pct(values[i] ?? 0, total)})`)}</title></rect>`
    x += w + 2

    return part
  }).join('')
  const body = total > 0 ? parts : `<rect class="track" width="${width}" height="${h}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    STYLE +
    `<clipPath id="r"><rect width="${width}" height="${h}" rx="4"/></clipPath>` +
    `<g clip-path="url(#r)">${body}</g></svg>`
  )
}

// A bar with 4px rounded corners on its data end, square on the baseline.
const barPath = (x: number, w: number, top: number, base: number): string => {
  const r = Math.min(4, w / 2, base - top)

  return (
    `M${x.toFixed(2)},${base}V${(top + r).toFixed(2)}` +
    `Q${x.toFixed(2)},${top.toFixed(2)} ${(x + r).toFixed(2)},${top.toFixed(2)}` +
    `H${(x + w - r).toFixed(2)}` +
    `Q${(x + w).toFixed(2)},${top.toFixed(2)} ${(x + w).toFixed(2)},${(top + r).toFixed(2)}` +
    `V${base}Z`
  )
}

export const dailySvg = (days: DayTotal[], width: number): string => {
  const h = 150
  const top = 18
  const bottom = 22
  const base = h - bottom
  const plot = base - top
  const peak = niceMax(Math.max(0, ...days.map(d => d.total)))
  const slot = width / Math.max(1, days.length)
  const barW = Math.min(28, slot * 0.62)

  const bars = days
    .map((d, i) => {
      const sx = i * slot
      const x = sx + (slot - barW) / 2
      const bh = d.total > 0 ? Math.max(2, (d.total / peak) * plot) : 0
      const label = i === days.length - 1 ? `Today (${d.label})` : d.label
      const mark = bh > 0 ? `<path class="m s1" d="${barPath(x, barW, base - bh, base)}"/>` : ''

      return (
        `<g class="bar"><title>${esc(`${label}: ${long(d.total)} tokens`)}</title>` +
        `<rect class="hit" x="${sx.toFixed(2)}" y="0" width="${slot.toFixed(2)}" height="${h}"/>` +
        `${mark}</g>`
      )
    })
    .join('')

  const first = days[0]?.label ?? ''
  const middle = days[Math.floor(days.length / 2)]
  const midX = (Math.floor(days.length / 2) + 0.5) * slot
  const labels =
    `<text class="lbl" x="2" y="${h - 6}">${esc(first)}</text>` +
    (middle ? `<text class="lbl" x="${midX.toFixed(2)}" y="${h - 6}" text-anchor="middle">${esc(middle.label)}</text>` : '') +
    `<text class="lbl" x="${width - 2}" y="${h - 6}" text-anchor="end">Today</text>` +
    `<text class="lbl" x="${width - 2}" y="${top - 5}" text-anchor="end">${esc(axis(peak))}</text>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    STYLE +
    `<line class="grid" x1="0" x2="${width}" y1="${top}" y2="${top}"/>` +
    `<line class="grid" x1="0" x2="${width}" y1="${top + plot / 2}" y2="${top + plot / 2}"/>` +
    bars +
    `<line class="base" x1="0" x2="${width}" y1="${base + 0.5}" y2="${base + 0.5}"/>` +
    labels +
    `</svg>`
  )
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const sparkline = (days: DayTotal[]): string => {
  const peak = Math.max(0, ...days.map(d => d.total))

  return days
    .map(d => {
      if (d.total <= 0 || peak <= 0) return ' '
      const i = Math.min(SPARK.length - 1, Math.floor((d.total / peak) * (SPARK.length - 1)))

      return SPARK[Math.max(0, i)] ?? ' '
    })
    .join(' ')
}

// The terminal's stacked bar: one run of blocks per kind.
const blockRuns = (t: Totals, width: number): { color: string; text: string }[] => {
  const values = KINDS.map(k => t[k.key])
  if (sum(t) <= 0) return [{ color: '#898781', text: '░'.repeat(width) }]
  const widths = segments(values, width, 0, 1).map(w => Math.round(w))

  return KINDS.map((k, i) => ({ color: k.light, text: '█'.repeat(widths[i] ?? 0) }))
}

const stats = (v: View) => {
  const input = v.lifetime.input + v.lifetime.cacheRead + v.lifetime.cacheWrite
  const pages = (v.lifetime.output * 0.75) / 500
  const busiest = v.days.reduce<DayTotal | undefined>(
    (best, d) => (d.total > (best?.total ?? 0) ? d : best),
    undefined,
  )

  return [
    { key: 'session', caption: 'This session', value: short(sum(v.session)) },
    { key: 'cache', caption: 'Read from cache', value: pct(v.lifetime.cacheRead, input) },
    {
      key: 'pages',
      caption: 'Claude wrote',
      value: pages < 1 ? '< 1 page' : `≈ ${long(pages)} pages`,
    },
    {
      key: 'busiest',
      caption: 'Busiest day (14d)',
      value: busiest ? `${busiest.label} · ${short(busiest.total)}` : '–',
    },
  ]
}

export async function drawPane($: Engine, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const v = await read($, view)

  if (v === null) {
    return <Text dimColor>Counting your tokens…</Text>
  }

  const total = sum(v.lifetime)
  const columns = Math.max(20, e.props.bodyColumns - 2)
  const since = v.since > 0 ? ` since ${dateLabel(v.since)}` : ''
  const scanning = v.isScanning ? ' · reading past sessions…' : ''
  const sessions = `${long(v.sessions)} session${v.sessions === 1 ? '' : 's'}`

  const hero = (
    <Box flexDirection="column">
      <Text dimColor size="caption" weight="medium">
        LIFETIME TOKENS
      </Text>
      <Text size="title" weight="bold" bold>
        {short(total)}
      </Text>
      <Text dimColor size="footnote">
        {long(total)} tokens · {sessions}
        {since}
        {scanning}
      </Text>
    </Box>
  )

  // The small form of a minimized pane: the headline alone.
  if (e.props.placement === 'widget') {
    return (
      <Box flexDirection="column">
        {hero}
        <Text dimColor size="footnote">
          This session: {short(sum(v.session))}
        </Text>
      </Box>
    )
  }

  const legend = (
    <Box flexDirection="column">
      {KINDS.map(k => (
        <Box key={`legend-${k.key}`} flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={k.light}>■</Text> {k.name}
          </Text>
          <Text tabular dimColor>
            {long(v.lifetime[k.key])} · {pct(v.lifetime[k.key], total)}
          </Text>
        </Box>
      ))}
    </Box>
  )

  const tiles = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
      {stats(v).map(s => (
        <Box key={`stat-${s.key}`} flexDirection="column">
          <Text dimColor size="caption">
            {s.caption}
          </Text>
          <Text weight="semibold" bold>
            {s.value}
          </Text>
        </Box>
      ))}
    </Box>
  )

  const peak = Math.max(0, ...v.days.map(d => d.total))
  const dailyCaption = (
    <Text dimColor size="caption" weight="medium">
      LAST 14 DAYS
    </Text>
  )

  if (e.surface === 'terminal') {
    const runs = blockRuns(v.lifetime, Math.min(60, columns))

    return (
      <Box flexDirection="column" gap={1}>
        {hero}
        <Box flexDirection="column">
          <Text>
            {runs.map(r => (
              <Text color={r.color}>{r.text}</Text>
            ))}
          </Text>
          {legend}
        </Box>
        <Box flexDirection="column">
          {dailyCaption}
          <Text color={KINDS[0].light}>{sparkline(v.days)}</Text>
          <Text dimColor>
            {v.days[0]?.label ?? ''} → today · peak {short(peak)}
          </Text>
        </Box>
        {tiles}
      </Box>
    )
  }

  const { Svg } = $.ui.resolve(e)
  const width = pixels(columns)
  const shares = KINDS.map(k => `${k.name} ${pct(v.lifetime[k.key], total)}`).join(', ')
  const dailyAlt = v.days.map(d => `${d.label}: ${long(d.total)}`).join('; ')

  return (
    <Box flexDirection="column" gap={1}>
      {hero}
      <Box flexDirection="column" gap={1}>
        <Svg
          source={compositionSvg(v.lifetime, width)}
          alt={`Where your tokens went: ${shares}`}
          isInteractive
        />
        {legend}
      </Box>
      <Box flexDirection="column">
        {dailyCaption}
        <Svg
          source={dailySvg(v.days, width)}
          alt={`Tokens per day, last 14 days: ${dailyAlt}`}
          isInteractive
        />
      </Box>
      {tiles}
    </Box>
  )
}

export async function togglePane($: Engine): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE && p.isPlaced)) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
  }
}

export async function launcherLabel($: Engine): Promise<string> {
  const v = await read($, view)

  return v === null ? '◈ tokens' : `◈ ${short(sum(v.lifetime))}`
}
