# claude-mods

Mods for [Claude Code](https://claude.com/claude-code).

## lifetime-tokens

Keeps a running count of every token you've used in Claude Code on your machine, across all sessions.

- **Launcher button**: a small `◈ 5.38M` button beside the mode label at the foot of the prompt (desktop app and terminal) or on the hint line under the prompt (mobile app). Press it to open or close the dashboard.
- **Dashboard**: your lifetime total; a bar showing how it splits into input, output, cache writes and cache reads; a 14-day chart of tokens per day; and quick stats (this session, share read from cache, pages Claude has written, busiest day). Works in light and dark mode, and falls back to text blocks in the terminal.
- **`/tokens`**: opens the dashboard and prints the full breakdown with a 14-day sparkline.
- **Status line**: `Lifetime tokens: 5.38M · this session: 177.2K`.

The first time it runs it reads the session transcripts already on your machine, so your total starts from your real history (Claude Code keeps transcripts for 30 days by default, so older history may be gone). From then on it counts every turn live, including subagents and context compaction. Totals live in the mod's own store in your Claude config folder, so every session adds to the same number.

It counts Claude Code usage, not claude.ai chats. The button and dashboard draw wherever Claude Code shows mod UI: the terminal and the desktop app's local sessions. A cloud session viewed in the app runs headless and draws no mod UI there; `/tokens` still works.

### One total across cloud sessions and computers

After every turn the mod also copies its daily totals to a dashboard page on your Claude account (one row per day for each session or computer), so cloud sessions, whose machines are wiped when they end, still add to one lifetime total. Open that page from the app's sidebar in any session; `/tokens` prints its link.

The address of that page is `DASHBOARD_URL` in `lifetime-tokens/hooks/sync.ts`. It belongs to this repository's owner, so if you install the mod yourself, point it at a dashboard of your own; otherwise the copy is refused and everything else works as before.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install lifetime-tokens --marketplace aaa628/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every session.

From a shell:

```bash
claude plugin install lifetime-tokens --marketplace aaa628/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `aaa628/claude-mods`, then **Add plugin**.
