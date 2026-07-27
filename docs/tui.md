# Switch Interactive TUI

The interactive terminal UI is the default experience when you run `switch`
with no subcommand in a TTY.

```bash
switch          # splash → main session
switch tui      # explicit
switch chat     # alias
```

Batch commands (`ask`, `route`, `doctor`, `serve`, …) still work for scripts and
`--json` automation.

## Layout

- **Main pane** — query stream with collapsed council stages by default
- **Right rail** — mode, config source, approach + paper link, roles with
  **concrete model IDs**, goal, live invocation, token/call usage
- **Footer** — input line and status

### Roles · models rail

Each seat is three lines:

1. **Role** (e.g. Architect) plus `[synth]` / `[router]` when relevant
2. **Model** (e.g. `gpt-5.6-sol`, `gemini-3.1-pro-high`,
   `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`)
3. **Connector · display name** (e.g. `codex · Codex Architect`)

### Approach papers

The current approach shows its paper title and arXiv URL. Open it with:

- `/paper` — current approach
- `/paper independent-critique-synthesis` — specific approach
- `/protocols` then **`o`** — open the highlighted approach’s paper
- Enter on a protocol still **selects** it (and prints the paper URL)

## Modes

| Mode      | Behavior                                       |
| --------- | ---------------------------------------------- |
| `council` | Fixed protocol + roster for the session        |
| `routed`  | Dynamic router chooses a plan per query        |
| `direct`  | Single-participant style profiles              |
| `plan`    | Plan-mode prefix + GCV-style planning emphasis |

## Config sources

| Source    | Behavior                                                    |
| --------- | ----------------------------------------------------------- |
| `default` | Built-in product presets (not LLM)                          |
| `manual`  | You set approach, rounds, members                           |
| `auto`    | Auto-decider LLM chooses approach/roles/params (authorized) |

## Slash commands

See `/help` inside the TUI. Highlights:

- `/setup` — provider connect wizard (no credential scraping)
- `/mode council|routed|direct|plan`
- `/config manual|default|auto`
- `/protocols` / `/protocol <id>` / `/paper [id]` / `/rounds <n>`
- `/goal <text>` / `/plan` / `/tools` / `/tool …`
- `/expand` `/collapse` — stream density (Tab toggles last stage)

## Security

Setup hands off login to official CLIs (Codex, Antigravity, Grok, OpenCode).
OpenRouter uses `OPENROUTER_API_KEY` by reference only. Switch does not read
subscription credential stores.
