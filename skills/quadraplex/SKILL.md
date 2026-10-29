---
name: quadraplex
description: Read portfolio state for the npm, JSR, PyPI, Packagist, NuGet and AUR packages, container images, browser extensions, agent skills and GitHub repos a user publishes, including download, user and star deltas. Use when asked what changed across someone's published projects, how a package, extension or repo is doing, or which of their projects moved recently.
---

# quadraplex

A local store of everything the user publishes: npm, JSR, PyPI, Packagist, NuGet and AUR packages, Ruby gems,
container images on ghcr.io and Docker Hub, Firefox add-ons, Chrome extensions, ClawHub skills and GitHub repos with their releases and agent skills, with per-day download history where a source serves one, and
deltas measured against a time anchored baseline.

The store is already on disk. Your job is to read it, not to rebuild it.

## Read the snapshot first

`state.json` is the whole portfolio in one file. It costs no process start and no network,
and it answers most questions outright.

```
$XDG_DATA_HOME/quadraplex/state.json
```

When `XDG_DATA_HOME` is unset that is `~/.local/share/quadraplex/state.json` on Linux and
`~/.quadraplex/state.json` elsewhere.

Each entry carries `id`, `ecosystem`, `name`, `url`, `metrics`, `deltas`,
`deltaBaselineAt`, `links`, `fetchedAt` and `stale`. An `npm:` entry may also carry
`versions`, its last 7 days of downloads per version. The file itself carries
`schemaVersion`, which is `2`.

Archived repos, forks and deprecated packages are absent unless `includeArchived`,
`includeForks` or `includeDeprecated` is set in config. A project that was deleted,
unpublished, made private or handed to another account is retired and absent too. Treat the portfolio as the projects the user actively publishes, not as a listing
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
qplex ghcr shbernal/alcatraz --json
qplex dockerhub shbernal/alcatraz --json
qplex rubygems some-gem --json
qplex jsr @shbernal/slug --json
qplex packagist shbernal/some-lib --json
qplex nuget shbernal.somelib --json
qplex amo rebobinate --json
qplex cws hjagmapcdgdffjbbedipfoocmkmhbjeh --json
qplex clawhub rfc-lookup --json
qplex vscode esbenp.prettier-vscode --json
qplex openvsx redhat.java --json
qplex aur och --json
```

Add `--fresh` to refetch that one target when the answer has to be current:

```sh
qplex gh shbernal/gitpulse --json --fresh
```

## When nothing is set up

`status` hints that say to run `qplex init` mean the install has no accounts yet. Ask the
user for their handle, or propose one, and check it before writing anything:

```sh
qplex init --suggest --json
qplex init --suggest --npm their-npm-name --only npm --json
```

Each suggestion says what the ecosystem holds for that account. Write only the accounts
the user confirms:

```sh
qplex init --github their-login --npm their-npm-name
```

The store stays empty until a refresh, and the rule below still holds for the first one.

`init` merges into the existing config, and `--npm ''` removes an account.

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

**An add-on has no per-day series.** AMO serves download history only to the add-on's
owner, so `amo:` targets carry `users`, the average daily user count, as a level rather
than a flow. Its history is whatever the store has accumulated, exactly like stars.

**A Chrome extension's `users` is a string, not a number.** The Chrome Web Store has no
read API and publishes a rounded bucket, so a `cws:` target carries `users: "1,000"` and
never a delta on it. Report it as approximate, say "about a thousand", and never subtract
two of them. `null` there means the store showed no badge at all, which happens below a
few dozen users. `rating` and `ratings` on the same target are exact and do move.

**Release metrics on a `gh:` target exist only when the repo has released.** `version`,
`lastPublish`, `downloadsTotal` and `unreleasedCommits` are absent on a repo that never
shipped a GitHub Release, which is not zero downloads. `unreleasedCommits` counts the
default branch past the latest release tag, `null` when that tag no longer exists. `downloadsTotal` is lifetime with no per-day series,
so its delta is the only rate. A `ghcr:` image has a per-day series, but its
`downloadsMonth` covers 29 days because the page's chart includes today, which is dropped.
A `dockerhub:` image has only `downloadsTotal`, lifetime pulls with no series, so its
delta is the only rate. It names no repo; the dashboard joins it to the ghcr.io image or
repo of the same name.

**A `rubygems:` gem has no per-day series either.** `downloadsTotal` counts every version
for all time and `downloadsVersion` only the current one, so their deltas are the only
rates, and `downloadsVersion` restarts near zero on a release. A gem whose versions were all
yanked is retired.
**A `jsr:` package carries `score`, `runtimes` and `dependents` beside its downloads.**
`score` is JSR's 0 to 100 package quality score, `runtimes` the comma-separated runtimes
it declares (`browser,bun,deno,node,workerd`), `null` when none. Its downloads sum registry
reads and npm compatibility tarballs over a 90-day series.

**A `vscode:` or `openvsx:` target is one editor extension, named `publisher.name`.**
`installs` on the Marketplace and `downloadsTotal` on Open VSX are lifetime counts with no
series, so their delta is the only rate, and the two are different units: never add them.
The dashboard joins the two listings of one extension by name.

**An `aur:` package counts no downloads.** `votes` is a lifetime count whose delta is the
only rate; `popularity` is the AUR's own score of recent votes, decaying daily, so it can
fall with nothing happening. `version` is the upstream one without the pkgrel, and `null`
on a VCS package (`-git` and the like), which builds from the branch head. `outOfDate` is
`"no"` or the time the package was flagged.

**A `packagist:` package has a per-day series and a lifetime `downloadsTotal`**, plus
`favers` and `dependents`. Packagist's mirror of the repo's GitHub stars is left out; read
the linked `gh:` target. An abandoned package has `deprecated: "yes"`. A `nuget:` package
has only `downloadsTotal`, lifetime with no series, so its delta is the only rate, and
`verified` says whether its ID prefix is reserved. Its name is the package ID lowercased.

**`versions` on an `npm:` target splits `downloadsWeek` by version.** A version with a
prerelease part (`0.3.0-next.4`) belongs to that prerelease track, so summing by track
answers who installs `next` versus stable. Absent means not measured, and a version with no
downloads is left out. Past splits live only in `snapshots.jsonl`, one per snapshot line.

**Skill metrics on a `gh:` target exist only when the repo publishes agent skills.**
`skills` counts the skills `npx skills add <repo>` would offer. `skillInstalls` is their
lifetime install count on skills.sh, which only knows a skill somebody installed through
that CLI, so `null` there means none indexed, not zero installs.

**A `clawhub:` target is one skill, not a repo.** `installs` is ClawHub's lifetime count
of users whose CLI reported an install. ClawHub discards skills.sh's events, so a skill's
installs across skills.sh and ClawHub are its `skillInstalls` share plus `installs`, never double
counted.

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
