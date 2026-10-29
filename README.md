<div align="center">

<img src="docs/assets/hero.webp" alt="Dexter at the Quadraplex console" width="420">

<img src="docs/assets/wordmark.svg" alt="QUADRAPLEX" width="560">

Monitor your development projects like an evil genius.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

**[<kbd> <br> Install <br> </kbd>][Install]**
**[<kbd> <br> Quickstart <br> </kbd>][Quickstart]**
**[<kbd> <br> For agents <br> </kbd>][For agents]**
**[<kbd> <br> Docs <br> </kbd>][Docs]**

---

</div>

![qplex dashboard demo](docs/assets/demo.gif)

quadraplex collects your npm and PyPI packages, Ruby gems, ghcr.io and Docker Hub images, browser extensions and GitHub repos into one local store.
A terminal dashboard shows each metric against a baseline, and a JSON surface answers agents from the same cache.

Named after the Quadraplex T-3000, the computer that oversees the lab in _Dexter's Laboratory_.
It reports on the facility. It does not run it.

- **Deltas, not totals.** "+120 downloads since Aug 19" instead of a number you have to remember.
- **Instant dashboard.** The TUI reads the local store and never fetches, so it works offline.
- **One pane per group of ecosystems.** GitHub, registries and extension stores, plus agent skills once ClawHub is set, with a sources panel showing how old each ecosystem's data is.
- **Drift between ecosystems.** Chrome on 1.4.0 and Firefox on 1.4.1 shows on the row, and so do commits pushed after the last release.
- **Built for agents.** Cached JSON answers most questions with zero requests. Only single-target lookups may refetch.
- **No token required.** Public data only. A GitHub token raises rate limits and is never needed.

## What it tracks

| Source                                                                                          | Information                      | Discovered from                        |
| ----------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------- |
| <img src="https://cdn.simpleicons.org/npm" alt="" height="16"> npm                              | packages                         | your npm username                      |
| <img src="https://cdn.simpleicons.org/python" alt="" height="16"> PyPI                          | packages                         | your PyPI username                     |
| <img src="https://cdn.simpleicons.org/github/181717/white" alt="" height="16"> GitHub           | repos, releases and agent skills | your public repos                      |
| <img src="docs/assets/container.svg" alt="" height="16"> ghcr.io                                | images                           | your ghcr.io owner                     |
| <img src="https://cdn.simpleicons.org/docker" alt="" height="16"> Docker Hub                    | images                           | your Docker Hub namespace              |
| <img src="https://cdn.simpleicons.org/rubygems" alt="" height="16"> RubyGems                    | gems                             | your RubyGems handle                   |
| <img src="https://cdn.simpleicons.org/firefoxbrowser" alt="" height="16"> Firefox Add-ons (AMO) | extensions                       | your numeric author id                 |
| <img src="https://cdn.simpleicons.org/googlechrome" alt="" height="16"> Chrome Web Store        | extensions                       | the "Offered by" name on your listings |
| ClawHub                                                                                         | agent skills                     | your ClawHub publisher handle          |

Anything discovery misses, like an unlisted Chrome extension, goes in the config's `include` list.

## Install

```sh
npm install -g quadraplex
```

This installs `quadraplex` and its short alias `qplex`.

## Quickstart

1. Run `qplex`.
   The first launch opens the accounts screen, prefilled from your gh or git login, and shows what each ecosystem holds for you.
2. Edit any row that's wrong, then save.
   This writes the config and runs the first refresh.
3. The dashboard opens. Press `?` for every key and symbol.
4. Later, run `qplex refresh` to fetch new data. It's the only command that touches the network.

To skip the accounts screen, write the accounts directly:

```sh
qplex init --github you --npm you
```

The config lives at `~/.config/quadraplex/config.json`. Archived repos, forks and deprecated packages are hidden by default. See [Config](docs/architecture.md#config) for every key.

Icons come from a [Nerd Font](https://www.nerdfonts.com). Without one, set `QUADRAPLEX_ASCII=1`.

Bash completion covers commands, flags and the target names in your store, read from cache. Add this to `~/.bashrc`:

```sh
eval "$(qplex completions bash)"
```

## For agents

Point your agent at the snapshot, not the network.
This prints a compact index of everything from cache:

```sh
qplex status --json
```

This prints one target, and `--fresh` refetches only that one:

```sh
qplex npm your-pkg --json --fresh
```

`--fresh` requires a target on purpose. Refetching the whole portfolio through the JSON surface is how rate limits die.

An installable skill teaches an agent this access strategy:

```sh
npx skills add shbernal/quadraplex
```

## How it works

```mermaid
flowchart LR
  R[npm · PyPI · GitHub · ghcr.io · Docker Hub · RubyGems · AMO · CWS] -->|qplex refresh| S[(snapshots.jsonl<br>append-only)]
  S --> D[derived state]
  D --> T[dashboard]
  D --> J[status / list --json]
```

Every refresh appends snapshots to a local log, which is the source of truth.
Everything else is derived from it and can be deleted at the cost of requests, never data.
Deltas compare the latest snapshot against a time-anchored baseline.

## Docs

- [Commands](docs/commands.md): every command, flag and the JSON contract
- [Architecture](docs/architecture.md): store, deltas, drift, staleness and config
- [GitHub](docs/github.md): rate limits, the issue and PR split, star curves
- [Decisions](docs/adr/): what was decided and when to revisit it
- [Contributing](CONTRIBUTING.md)

[Install]: #install
[Quickstart]: #quickstart
[For agents]: #for-agents
[Docs]: #docs
