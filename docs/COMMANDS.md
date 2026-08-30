# Command surface

Exit codes: `0` success, `1` runtime failure, `2` usage error.

Every JSON payload carries `schemaVersion`, and every target inside one carries
`fetchedAt` and `stale`.

## `qplex`

With a TTY, opens the dashboard. Piped or redirected, prints the `status` table instead
and never enters raw mode.

## `qplex refresh [--only npm|pypi|github|amo|cws] [--curves]`

The only command that walks the portfolio. Discovers targets, fetches each one, appends
one snapshot line per target, then rewrites `state.json`.

A failing target keeps its previous values and gains an `errors` entry. The command exits
non-zero only when every target failed.

`--curves` rebuilds star history instead of the routine metrics. It is separate because a
curve costs about 17 requests per repo, which would consume an unauthenticated GitHub
budget in a single command.

It also harvests the most recent stargazer logins, which ride in on the pages the curve is
sampled from and add no requests. They are what the dashboard's detail pane lists.

## `qplex status [--json]`

A compact index of everything, from cache. Per target: id, ecosystem, name, how it was
discovered, one headline metric, its delta and baseline, `changed`, `stale`, `fetchedAt`.

The payload also carries `discovery` per ecosystem, `auto` or `config` or `empty`, and
`hints` for the cases where an empty section would otherwise read as "you have nothing
here".

`--fresh` is a usage error.

## `qplex list <ecosystem> [--json]`

One ecosystem, names plus a one-line state each, from cache. `--fresh` is a usage error.

## `qplex npm <pkg> | pypi <pkg> | gh <owner/repo> | amo <slug> | cws <id> [--json] [--fresh]`

One target in full: every metric, every delta, the download or star series when there is
one, and the GitHub issue and PR detail used by the dashboard modal.

`--fresh` refetches that one target and appends a snapshot, so a targeted fresh read still
becomes history.

## The JSON contract for agents

Read `state.json` directly for breadth. It costs no process start and no network. Use
`status --json` when you want the index rather than the whole store, and a targeted
command when you already know what you are looking at.

Two fields are easy to misread:

- `deltas` is `null` on a first run and means unknown, not zero. It is measured against
  `deltaBaselineAt`, not against yesterday.
- `stale` is a computed TTL verdict. Trust it rather than re-deriving it from `fetchedAt`.
