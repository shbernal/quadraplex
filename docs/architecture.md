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
$XDG_CONFIG_HOME/quadraplex/   (~/.config/quadraplex)
  config.json         accounts, exclusions, manual targets, TTL overrides
$XDG_DATA_HOME/quadraplex/     (~/.local/share/quadraplex)
  snapshots.jsonl     one line per target per refresh, append-only history
  state.json          latest snapshot per target with deltas, derived, rewritten wholesale
$XDG_CACHE_HOME/quadraplex/    (~/.cache/quadraplex)
  cache.json          ETags and conditional-request bookkeeping, per endpoint
  series/<id>.json    per-day download history, refetched not accumulated
  detail/<id>.json    open issues and PRs per target, for the dashboard
  curves/<id>.json    star history plus recent stargazer logins, one file per repo
  releases/<id>.json  a repo's latest release and its per-asset downloads
  skills/<id>.json    a repo's agent skills and their installs
```

That split applies on Linux, and elsewhere once any XDG variable is set. Otherwise
everything shares `~/.quadraplex/`. `QUADRAPLEX_HOME` forces that single-directory layout
at any root, which is what the tests use.

A per-target file name encodes the id reversibly: letters, digits, `.` and `-` pass, and
every other byte becomes `_` and two hex digits, so `npm:@scope/name` is
`npm_3a_40scope_2fname.json` and no two ids share a file.

**Cache is not history.** `snapshots.jsonl` is the only file the network cannot rebuild.
`state.json` and everything under the cache directory are derived or refetchable, so
deleting them costs requests and never data. ETags are per-endpoint and mutable, which is
the wrong shape for an append-only log, so they live in `cache.json` instead.

A damaged file degrades the same way. A derived file that fails to parse reads as missing.
A line of `snapshots.jsonl` that fails to parse, typically the torn tail of an interrupted
refresh, is skipped with a one-line count on stderr, and the next append starts on a fresh
line so it cannot merge into a wrong record. Derived files are written to a temp file and
renamed, so a reader never sees half of one.

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
  ecosystem:
    'npm' | 'pypi' | 'github' | 'ghcr' | 'amo' | 'cws' | 'clawhub' | 'dockerhub' | 'rubygems'
  name: string
  url: string
  discovered: 'auto' | 'config'
  metrics: Record<string, number | string | null>
  deltas: Record<string, number | null> | null
  deltaBaselineAt?: string
  links: string[]
  versions?: Record<string, number> // npm only, last 7 days of downloads per version
  fetchedAt: string
  stale: boolean
  errors?: string[]
}
```

Ecosystem-specific fields live inside `metrics`. A snapshot carries everything above
except `deltas`, `deltaBaselineAt` and `stale`, which are derived at read time from the
log and the clock.

## Sources

| Source    | Discovery         | Serves                                                 | Cost per target |
| --------- | ----------------- | ------------------------------------------------------ | --------------- |
| npm       | ownership roster  | daily downloads, per-version week, version, repo link  | 1 to 3 requests |
| pypi      | `user_packages`   | daily downloads, version, repo link                    | 2 requests      |
| github    | account repos     | stars, forks, the issue and PR split, releases, skills | 1 to 4 requests |
| ghcr      | packages tab      | daily downloads, version, repo link                    | 1 page, 2 calls |
| dockerhub | namespace listing | lifetime pulls, stars, version                         | 1 request       |
| rubygems  | owner listing     | lifetime downloads, this version's, version, repo link | 0, listing pays |
| amo       | author id search  | daily users, weekly downloads, rating, version         | 0, search pays  |
| cws       | search, verified  | a bucketed user count, rating, version                 | 1 page          |
| clawhub   | publisher roster  | lifetime installs, downloads, stars, version           | 1 request       |

**npm's search index is not a roster.** A deprecated package is dropped from
`maintainer:` search, which is silent in both directions: one deprecated before it was
ever seen never appears, and one deprecated afterwards keeps its last snapshot and ages
into stale with no explanation. Discovery therefore reads the ownership list at
`/-/user/<account>/package`, the same one `npm access list packages` prints, and uses
search only for the hits it can hand a fetch. A hit carries version, publish date and the
repository link, so those packages cost one request; a name only the roster knows pays for
its packument, and is by that fact deprecated. A roster that cannot be read degrades to
search alone rather than emptying the portfolio, and is reported as a partial discovery
so that nothing is retired for missing from it.

**npm's per-version split exists only for the current week.** `versions/<pkg>/last-week`
answers the last 7 days of downloads per version and nothing older, so unlike the daily
series it cannot be refetched later and lives on the snapshot, not in the cache. It costs a
request per package with any downloads that week, since that endpoint has no bulk form. A
failed read leaves the field absent and the target otherwise intact. Release tracks are
derived on read: a version with no prerelease part is `stable`, otherwise the track is the
first word of its prerelease part, so `0.2.2-next.5.g8622dc3` is `next`.

**An unpublished npm package simply vanishes.** It leaves the roster and search at once,
and its packument and download range both answer 404, with no tombstone document left
behind. Observed by unpublishing `@shbernal/tiny-slug` on 2026-10-02.

**PyPI's roster is XML-RPC.** The JSON API has no packages-by-user endpoint and the profile
page sits behind a JavaScript challenge, so discovery calls `user_packages`, one of the
methods PyPI kept when it deprecated XML-RPC. If it faults or is removed, discovery fails
and refresh falls back to known targets plus `include`, as for any source.

**The Chrome Web Store is the one source with no API.** Its published API manages items
and exposes no metrics, and the developer dashboard's numbers never leave the browser, so
the listing page is the only public reading of them. There is no developer page either, so
discovery searches the store for the account name and keeps the hits whose listing says
"Offered by" that account, handing the page it read to the fetch. Search ranking is not a
roster and an unlisted extension never appears, so `include` stays the supplement. Two
consequences are baked into the
shape of a `cws:` target rather than papered over:

- `users` is a **string**, because Google publishes a bucket. `"1,000"` is a rounded label,
  and the badge is missing entirely below a threshold, which reads as `null`. Storing it as
  a number would invite a delta, and a delta across buckets measures the boundary moving,
  not the users. Every consumer already suppresses deltas on a metric that is not a number.
- Every field is parsed independently and every one is allowed to be `null`. A layout
  change costs a metric and keeps the target, which is the same bargain a missing token
  strikes on GitHub. The one exception is the listing title: without it the response was
  not a listing, and the target records the error instead of an empty row.

**GitHub Releases ride on the repo target.** A repo that has released carries `version`,
`lastPublish`, `unreleasedCommits` (the default branch's commits past the latest release
tag, `null` when the tag is gone) and `downloadsTotal`, the lifetime count over every published release with
checksum and signature files left out. GitHub keeps no per-day history of asset
downloads, so the rate is the 24h delta. A repo that never released carries none of
them rather than zeros. [github.md](github.md) has the request cost.

**ClawHub's API has no per-publisher listing.** The publisher page reads its roster from
a public query on ClawHub's Convex deployment, `publishers:listPublishedPage`, and
discovery calls that same query. It is not part of the documented API, so if it moves,
discovery fails and refresh falls back to known targets plus `include`. Each skill is then
read from the documented `/api/v1/skills/<slug>?ownerHandle=<account>`, which answers 404
once the account no longer publishes it. Its `installs` counts users whose CLI reported an
install, the same unit as skills.sh, and ClawHub discards skills.sh's events, so the two
stores' counts add up.

**Agent skills ride on the repo target too.** A repo carries `skills`, the SKILL.md files
`npx skills add` would install from it, and `skillInstalls`, their total on skills.sh.
skills.sh counts what its CLI reports, so it only knows a skill somebody installed, and a
repo whose skills it has never seen carries `skillInstalls: null`. The repo's tree is the
roster and the index only supplies counts. [github.md](github.md) has the request cost.

**GHCR's downloads exist only on the package's GitHub page.** The REST packages API wants
`read:packages`, which no default login has, and the registry serves no counts. The page
is public and holds more than it shows: the exact total and publish time sit in the
`title` of the rounded headings, and the 30 day chart carries each day's count as data
attributes. The day in progress is dropped, so `downloadsMonth` covers 29 whole days.
Discovery reads the profile's packages tab, and the version is the highest semver tag
from the registry's tag list, which takes an anonymous pull token. As on the Chrome Web
Store every field may come back `null`, and a page with neither total nor publish time
records an error.

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

## Drift

Two readings a single store cannot give you, both derived from metrics already on disk. They live in `src/core/drift.ts` and are computed per project,
not per target, because that is the level at which the comparison exists at all.

- **Ecosystems disagree.** Chrome on 1.4.0 while Firefox is on 1.4.1 means one review queue
  was never followed up. Versions are compared across ecosystems only. An ecosystem whose
  own targets disagree contributes none, so a monorepo publishing packages on their own
  cadence is never reported as a defect.
- **Unreleased work.** A default branch pushed more than 24h after the newest
  `lastPublish`. The window matches the default delta window, and the shape of the data
  justifies it: real gaps are either under twenty minutes, which is the release commit
  landing, or over a week. A `lastPublish` known only to the day, as the Chrome Web Store
  publishes it, counts from the end of that day. When the repo's GitHub Release tag gives
  a count, `unreleasedCommits` decides instead, since a push to another branch moves
  `pushed_at` without putting anything past the release.

Neither reading reaches `state.json` or the JSON payloads. They are cheap enough to derive
at read time and would otherwise need a `schemaVersion` bump to change.

## Staleness

`stale` is computed from `fetchedAt` plus a per-ecosystem TTL, never guessed and never
hardcoded at a call site. Defaults, overridable under `ttl` in `config.json`:

| Ecosystem | TTL | Why                                          |
| --------- | --- | -------------------------------------------- |
| npm       | 24h | download data is daily                       |
| pypi      | 24h | pypistats lags about a day                   |
| github    | 1h  | issues and PRs move within a day             |
| amo       | 24h | daily users is recomputed once a day         |
| ghcr      | 24h | the page's chart is per day                  |
| dockerhub | 24h | pulls are a lifetime count                   |
| rubygems  | 24h | downloads are a lifetime count               |
| cws       | 24h | the published user count is a daily bucket   |
| clawhub   | 24h | installs are a slow, lifetime count          |
| curves    | 30d | star history is immutable except at the tail |
| releases  | 24h | reread sooner when the repo was pushed since |

**Partial failure is normal.** An ecosystem's 503 is a Tuesday. A failing target keeps its last
known values, gets `stale: true` and an `errors` entry. `refresh` never aborts wholesale,
and exits non-zero only when every target failed.

## Retirement

A target that is deleted, unpublished, made private or handed to another account is
retired: refresh appends a final snapshot that keeps the last values and adds
`retired: { at, reason }`. The derived state drops it, refresh stops fetching it, and any
later snapshot without the field, from discovery finding it again, revives it. It lives
in the log, so rebuilding the derived files keeps it.

What counts as proof depends on the source. Absence from a roster that answered in full,
npm, PyPI, GitHub or AMO, settles it without a request, and covers a transfer as well as
a deletion. A Chrome search or the GHCR packages tab can miss, so a known target missing from one is
fetched, and so is every `include` entry. Only the target's own resource answering 404, a store
page with no listing, or a discovered extension now offered by someone else retires it.
A 5xx, a timeout, a failed or partial discovery or the run deadline retire nothing and
carry forward as stale.

## Linking targets across ecosystems

A published package and its repo are one project to a human. The link is derived from
source metadata, `repository` on npm, `project_urls` on PyPI and `homepage` on AMO, stored
in `links`, and overridable in config. A Chrome Web Store listing publishes no repository
field at all, so a `cws:` target offered by the account links to the account's repo named
like its store slug, which is its title lowercased and hyphenated, and config overrides
that. A GHCR package links to the repo its page names. A ClawHub skill names no repo, so
the dashboard joins it to the repo publishing a skill with the same slug, unless config
links it. Only the TUI consumes it, but retrofitting an identity concept onto
a store that already has history is painful, so it is in from the start.

## The dashboard's panes

The dashboard is one bordered pane per group of ecosystems: GitHub, the registries (npm, PyPI,
RubyGems, GHCR and Docker Hub) and the extension stores (Chrome and Firefox). Each pane answers its own question, so each
pane has its own columns instead of one table with half its cells blank. A project is
filed in every pane it has a target in, so a package with a repo shows its downloads in
the registries pane and its stars in the GitHub pane. The project key ties those rows
together: moving between panes keeps the cursor on the project, and the other panes mark
its row.

Only the configured ecosystems are on the board. A pane is drawn when one of its
ecosystems has an account or an `include` entry, empty or not, and so is a sources lamp.
An ecosystem that loses its account leaves the dashboard while its snapshots stay in the
log, so adding the account back brings its history with it. Cursors, scrolls and sorts
are held per pane id, so a pane leaving does not move the others.

Each pane's border carries its gauges and the age of its oldest fetch against the TTL.
A wholly stale pane says so once in its border, and only a partly stale one marks rows.
On a wide terminal a sources panel shows each store's age, staleness, errors and
targets with no baseline. On a narrow one, panes out of focus fold down to their top
border, which still carries the gauges.

A Skills pane joins the board once ClawHub is configured, with one row per skill and a
column per store. Without it the skills.sh count stays a column of the GitHub pane, which
drops that column when the pane exists so no number is read twice. See
[ADR 0002](adr/0002-skills-pane.md).

Stores are never summed across units. Chrome's install bucket and Firefox's daily users
sit in separate columns, and the bucket is printed as Google's label, marked `≈`.

The filter runs across every pane at once, and the sort applies to the focused pane only.
Both work on the built board without rereading the store. Deltas are coloured by sign:
green rose, red fell, grey held or is unknown. Every delta carries its own sign, so
`NO_COLOR` loses the colour and none of the reading.

Icons come from a Nerd Font. `QUADRAPLEX_ASCII=1`, `NO_COLOR` and `TERM=dumb` switch to a
plain glyph table where every symbol is one ordinary cell.

## The accounts screen

A first launch, `qplex init` and `a` on the dashboard open one screen with a row per
ecosystem. Probing an account is a network call, so the screen runs `init --suggest
--json` as a child process exactly as the dashboard runs `refresh`, once for every row on
open and once per row whose value is edited. An answer to an edit that has since been
replaced is dropped. Saving is not fetching, so the screen writes the config itself
through the same validated, atomic write as `init`, then refreshes every configured
ecosystem in its own child at once, one progress row each, and hands over to the dashboard. Escape before
saving writes nothing. It quits a first launch, which starts over next time, and returns
to the dashboard when that is where the screen was opened.

## Config

Every key is optional, and none has an account behind it. The file existing is what marks
an install as set up: without it `status` and `list` read an empty store and say so, and
`refresh` refuses to run. A file that names no account and no `include` gets the same
refusal, since discovery would have nothing to key on.

`includeArchived`, `includeForks` and `includeDeprecated` govern what the derived state
keeps, not what refresh fetches. An archived repo, a fork and a deprecated package are
still snapshotted on every refresh, so flipping any of them back on is free and a
retirement being undone is noticed on its own. Filtering at discovery instead would leave
those targets frozen in the log and reported stale forever.

```jsonc
{
  "accounts": {
    "npm": "shbernal",
    "pypi": "shbernal",
    "github": "shbernal",
    "ghcr": "shbernal",
    "dockerhub": "shbernal",
    "rubygems": "shbernal",
    "amo": "20068285",
    "cws": "shbernal", // the listing's "Offered by" name
    "clawhub": "shbernal",
  },
  "exclude": ["npm:some-experiment"],
  "include": ["cws:abcdefghijklmnopabcdefghijklmnop"],
  "includeArchived": false,
  "includeDeprecated": false,
  "includeForks": false,
  "links": { "npm:@shbernal/gitpulse": ["gh:shbernal/gitpulse"] },
  // Overrides a derived link, such as a Chrome listing whose slug is not its repo's name.
  "ttl": {
    "npm": "24h",
    "pypi": "24h",
    "github": "1h",
    "ghcr": "24h",
    "dockerhub": "24h",
    "rubygems": "24h",
    "amo": "24h",
    "cws": "24h",
    "clawhub": "24h",
    "curves": "30d",
    "releases": "24h",
  },
  "deltaWindow": {
    "npm": "24h",
    "pypi": "24h",
    "github": "24h",
    "ghcr": "24h",
    "dockerhub": "24h",
    "rubygems": "24h",
    "amo": "24h",
    "cws": "24h",
    "clawhub": "24h",
  },
}
```
