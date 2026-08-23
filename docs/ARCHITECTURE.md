# Architecture

Two consumers, one store. Nothing fetches during a read.

```
discovery + fetchers  ->  snapshots.jsonl  ->  state.json  ->  agents (breadth)
                                  |
                                  +--------->  status --json  ->  agents (index)
                                  +--------->  <target> --json ->  agents (drill-down)
                                  +--------->  Ink TUI         ->  humans
```

## Breadth from cache, freshness from a target

| Command                                     | Scope                        | Network                    |
| ------------------------------------------- | ---------------------------- | -------------------------- |
| `refresh [--only <eco>] [--curves]`         | everything, or one ecosystem | yes, the only bulk fetcher |
| `status [--json]`                           | everything                   | never                      |
| `list <eco> [--json]`                       | one ecosystem                | never                      |
| `npm\|pypi\|gh <target> [--json] [--fresh]` | one target                   | cache, `--fresh` refetches |

`--fresh` on `status` or `list` is a hard error that names `refresh`. That single rule is
what stops an agent from expressing "refetch my portfolio" through the JSON surface, so it
is enforced in one place, `src/commands/guards.ts`, and not per command.

Every payload carries `schemaVersion`, `fetchedAt` and `stale` so a reader can tell cached
from live without guessing. `schemaVersion` is an integer starting at `1` and bumps on any
breaking change to `state.json` or to a `--json` payload.

## Store layout

```
$XDG_DATA_HOME/quadraplex/     (falls back to ~/.local/share/quadraplex)
  snapshots.jsonl     one line per target per refresh, append-only history
  state.json          latest snapshot per target with deltas, derived, rewritten wholesale
  config.json         accounts, exclusions, manual targets, TTL overrides
  cache.json          ETags and conditional-request bookkeeping, per endpoint
  series/<id>.json    per-day download history, refetched not accumulated
  curves/<id>.json    star history, one file per repo
```

`QUADRAPLEX_DATA_DIR` overrides the root, which is what the tests use.

**Cache is not history.** `snapshots.jsonl` is the only file the network cannot rebuild.
`state.json`, `cache.json`, `series/` and `curves/` are all derived or refetchable, so
deleting them costs requests and never data. ETags are per-endpoint and mutable, which is
the wrong shape for an append-only log, so they live in `cache.json` instead.

`series/` holds the per-day download counts. Both registries serve that history
themselves, so it is fetched whole on every refresh rather than accumulated line by line,
which keeps a 365-point array out of every snapshot record. AMO serves per-day statistics
only to an add-on's owner, so an add-on has no series and its history is whatever
`snapshots.jsonl` has accumulated since the day it was first seen.

Retention is everything, in v1. A line is small.

## Target model

One shape across ecosystems, so no consumer special-cases.

```ts
type Target = {
  id: string // "npm:@shbernal/gitpulse", "gh:shbernal/gitpulse", "amo:rebobinate"
  ecosystem: 'npm' | 'pypi' | 'github' | 'amo' | 'cws'
  name: string
  url: string
  discovered: 'auto' | 'config'
  metrics: Record<string, number | string | null>
  deltas: Record<string, number | null> | null
  deltaBaselineAt?: string
  links: string[]
  fetchedAt: string
  stale: boolean
  errors?: string[]
}
```

Ecosystem-specific fields live inside `metrics`. A snapshot carries everything above
except `deltas`, `deltaBaselineAt` and `stale`, which are derived at read time from the
log and the clock.

## Sources

| Source | Discovery         | Serves                                         | Cost per target |
| ------ | ----------------- | ---------------------------------------------- | --------------- |
| npm    | maintainer search | daily downloads, version, repo link            | 1 request       |
| pypi   | config            | daily downloads, version, repo link            | 2 requests      |
| github | account repos     | stars, forks, the issue and PR split           | 1 to 2 requests |
| amo    | author id search  | daily users, weekly downloads, rating, version | 0, search pays  |
| cws    | config            | a bucketed user count, rating, version         | 1 page          |

**The Chrome Web Store is the one source with no API.** Its published API manages items
and exposes no metrics, and the developer dashboard's numbers never leave the browser, so
the listing page is the only public reading of them. Two consequences are baked into the
shape of a `cws:` target rather than papered over:

- `users` is a **string**, because Google publishes a bucket. `"1,000"` is a rounded label,
  and the badge is missing entirely below a threshold, which reads as `null`. Storing it as
  a number would invite a delta, and a delta across buckets measures the boundary moving,
  not the users. Every consumer already suppresses deltas on a metric that is not a number.
- Every field is parsed independently and every one is allowed to be `null`. A layout
  change costs a metric and keeps the target, which is the same bargain a missing token
  strikes on GitHub. The one exception is the listing title: without it the response was
  not a listing, and the target records the error instead of an empty row.

## Deltas

A delta compares the current snapshot to **the newest snapshot at least one window
older**, not to whatever line precedes it in the log. Refresh spacing is arbitrary in a
pull-only tool, so a previous-line delta would read zero after two refreshes ten minutes
apart, and would print a three-week jump exactly like a daily one.

- The window is per ecosystem and defaults to 24h everywhere. Registry download counts
  only move once a day, and an hourly window on GitHub reports noise as news.
- `deltaBaselineAt` travels with `deltas` so a reader can say "+12 since Aug 19".
- When no snapshot predates the window, `deltas` is `null`. That is unknown, not zero, and
  every consumer renders it as **new**.
- A metric missing from the baseline gets a `null` entry rather than its own value, so a
  newly added metric does not appear as a spike.

## Staleness

`stale` is computed from `fetchedAt` plus a per-ecosystem TTL, never guessed and never
hardcoded at a call site. Defaults, overridable under `ttl` in `config.json`:

| Ecosystem | TTL | Why                                          |
| --------- | --- | -------------------------------------------- |
| npm       | 24h | download data is daily                       |
| pypi      | 24h | pypistats lags about a day                   |
| github    | 1h  | issues and PRs move within a day             |
| amo       | 24h | daily users is recomputed once a day         |
| cws       | 24h | the published user count is a daily bucket   |
| curves    | 30d | star history is immutable except at the tail |

**Partial failure is normal.** A registry 503 is a Tuesday. A failing target keeps its last
known values, gets `stale: true` and an `errors` entry. `refresh` never aborts wholesale,
and exits non-zero only when every target failed.

## Linking targets across ecosystems

A published package and its repo are one project to a human. The link is derived from
source metadata, `repository` on npm, `project_urls` on PyPI and `homepage` on AMO, stored
in `links`, and overridable in config. A Chrome Web Store listing publishes no repository
field at all, so a `cws:` target is linked from config or not at all. Only the TUI consumes it, but retrofitting an identity concept onto
a store that already has history is painful, so it is in from the start.

## Config

Every key is optional and the tool works with no config at all.

`includeArchived` and `includeForks` govern what the derived state keeps, not what refresh
fetches. An archived repo and a fork are still snapshotted on every refresh, so flipping
either key back on is free and an unarchive is noticed on its own. Filtering at discovery
instead would leave those targets frozen in the log and reported stale forever.

```jsonc
{
  "accounts": { "npm": "shbernal", "pypi": "shbernal", "github": "shbernal", "amo": "20068285" },
  "exclude": ["npm:some-experiment"],
  "include": ["pypi:thing-discovery-missed", "cws:hjagmapcdgdffjbbedipfoocmkmhbjeh"],
  "includeArchived": false,
  "includeForks": false,
  "links": { "npm:@shbernal/gitpulse": ["gh:shbernal/gitpulse"] },
  // A Chrome listing names no repository, so its link is the one case config must supply.
  "ttl": {
    "npm": "24h",
    "pypi": "24h",
    "github": "1h",
    "amo": "24h",
    "cws": "24h",
    "curves": "30d",
  },
  "deltaWindow": { "npm": "24h", "pypi": "24h", "github": "24h", "amo": "24h", "cws": "24h" },
}
```
