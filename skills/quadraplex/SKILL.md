---
name: quadraplex
description: Read portfolio state for the npm packages, PyPI packages and GitHub repos a user publishes, including download and star deltas. Use when asked what changed across someone's published projects, how a package or repo is doing, or which of their projects moved recently.
---

# quadraplex

A local store of everything the user publishes: npm packages, PyPI packages and GitHub
repos, with per-day download history and deltas measured against a time anchored baseline.

The store is already on disk. Your job is to read it, not to rebuild it.

## Read the snapshot first

`state.json` is the whole portfolio in one file. It costs no process start and no network,
and it answers most questions outright.

```
$XDG_DATA_HOME/quadraplex/state.json
```

When `XDG_DATA_HOME` is unset that is `~/.local/share/quadraplex/state.json`.

Each entry carries `id`, `ecosystem`, `name`, `url`, `metrics`, `deltas`,
`deltaBaselineAt`, `links`, `fetchedAt` and `stale`. The file itself carries
`schemaVersion`, which is `1`.

Archived repos and forks are absent unless `includeArchived` or `includeForks` is set in
config. Treat the portfolio as the projects the user actively publishes, not as a listing
of their GitHub account.

## Then the compact index

```sh
qplex status --json
```

Returns one line of state per target: the headline metric, its delta, whether anything
changed, and how the ecosystem's list was obtained. Use it when you want the index rather
than every metric.

`qplex list npm --json` narrows the same thing to one ecosystem.

## Then drill into one thing

```sh
qplex npm charcheck --json
qplex pypi mcp-server-rfc --json
qplex gh shbernal/gitpulse --json
```

Add `--fresh` to refetch that one target when the answer has to be current:

```sh
qplex gh shbernal/gitpulse --json --fresh
```

## What you must not do

**`--fresh` requires a target.** `qplex status --fresh` and `qplex list npm --fresh` exit
with an error naming `refresh`. That is deliberate, not a bug to work around. Do not try
to reach the same result by looping targeted `--fresh` calls over the whole portfolio.

**`refresh` is a human or timer action.** It is the only command that walks everything, and
it spends the GitHub rate limit budget. Run it only when the user asks you to.

## Two fields that are easy to misread

**`deltas: null` means unknown, not zero.** It is null on a first run and for a newly
discovered target, because no snapshot exists far enough back to compare against. Say
"new", never "no change". When deltas are present they are measured against
`deltaBaselineAt`, not against yesterday, so quote the date: "+26 since Aug 20".

**`stale` is a computed verdict** against a per-ecosystem TTL. Trust it. Do not re-derive
staleness by comparing `fetchedAt` to the current time, and do not treat a stale target as
missing. It has real values, they are just older than their TTL.

Also worth knowing: `openIssuesAndPRs` is GitHub's combined count. When `openIssues` and
`openPRs` are non-null the split was actually counted; when they are null, only the
combined number is known and it must not be reported as an issue count.

## The pattern to copy

Question: "what moved in my projects this week?"

```sh
qplex status --json
```

Read the entries where `changed` is true. Suppose two moved, `npm:charcheck` and
`gh:shbernal/ts-pptx`. Now spend one targeted call each:

```sh
qplex npm charcheck --json
qplex gh shbernal/ts-pptx --json
```

Answer from those three payloads. Three requests to the local store, no network, and the
user gets the two things that actually changed instead of a dump of forty that did not.

The wrong version of the same task is running `refresh`, or running a targeted `--fresh`
per target, and then summarizing everything. That spends the rate limit budget and buries
the answer.
