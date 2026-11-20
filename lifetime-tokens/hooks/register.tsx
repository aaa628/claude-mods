import type { Register } from 'claude-code'

import { addUsage, report, start } from './count'
import { DASHBOARD_URL, sync } from './sync'
import { drawPane, launcherLabel, PANE, PANE_TITLE, togglePane } from './ui'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Open the lifetime token dashboard and print the totals',
    })
    await start($)
    // Off the start path, then every minute (a no-op while nothing changed):
    // copies the day totals to the dashboard on your Claude account.
    $.clock.after(0, () => void sync($))
    $.clock.every(60_000, () => void sync($))

    return next(e)
  })

  // Every turn of the main conversation and of each subagent: the summed
  // usage of that turn's model requests. A failure to count never touches
  // the turn: the handler hands back what `next` settled to.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage ?? result.usage
    if (usage) {
      await addUsage($, usage)
      $.clock.after(0, () => void sync($))
    }

    return result
  }).catch(($, e, next) => next(e))

  // Compaction makes a model request of its own that no turn reports.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && 'usage' in result && result.usage) {
      await addUsage($, result.usage)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tokens' }, async $ => {
    // Where no surface draws mod UI the pane waits undrawn; the text below
    // carries the numbers either way.
    void $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)

    return { text: `${await report($)}\nDashboard, every session and computer: ${DASHBOARD_URL}` }
  })

  // The dashboard.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  // The launcher: a small button beside the mode labels in the prompt's
  // footer (terminal and desktop), the engine's own labels kept.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const label = await launcherLabel($)

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {engine}
        <Button key="lifetime-tokens-open" plain label={label} onPress={() => void togglePane($)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // The mobile app has no mode labels: the button goes on the hint line
  // under the prompt instead.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'mobile') return engine
    const { Box, Button } = $.ui.resolve(e)
    const label = await launcherLabel($)

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {engine}
        <Button key="lifetime-tokens-open" plain label={label} onPress={() => void togglePane($)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
