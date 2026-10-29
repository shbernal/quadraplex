# quadraplex

A portfolio monitor: what one person publishes across registries, extension stores,
ClawHub and GitHub, measured over time from public data.

## Language

### What is measured

**Portfolio**:
Everything the configured accounts publish, plus config `include` entries, minus exclusions.
_Avoid_: inventory, catalog

**Ecosystem**:
One publishing platform quadraplex reads, such as npm, PyPI, GitHub or the Chrome Web Store.
_Avoid_: platform, provider, store (for the service itself; "Chrome Web Store" and "extension stores" stay as names)

**Registry**:
A package or container registry ecosystem: npm, PyPI, RubyGems, GHCR or Docker Hub. The registries pane shows exactly these.
_Avoid_: registry for any other ecosystem, such as GitHub, AMO, the Chrome Web Store or ClawHub

**Account**:
The identity quadraplex keys discovery on in one ecosystem: a username, handle or AMO numeric id.
_Avoid_: user, profile, handle (except for the gh login `init --suggest` starts from)

**Target**:
One published thing in one ecosystem, identified by `<ecosystem>:<name>`, such as `npm:@shbernal/gitpulse` or `gh:shbernal/gitpulse`.
_Avoid_: item, artifact, entry

**Project**:
The targets a human sees as one thing, grouped through their links, such as a package and its repo.
_Avoid_: app, product

**Link**:
A connection between two targets of one project, derived from source metadata or set in config.

**Skill**:
An agent skill: a `SKILL.md` a repo publishes, counted on skills.sh, or a slug published on ClawHub.

**Index**:
skills.sh, which counts installs of a repo's skills. It is not an ecosystem: its counts ride on the `gh:` target.
_Avoid_: store

**Metric**:
One named value of a target, a number, a label or `null`.

**Headline metric**:
The one metric that leads a target's row and summary, fixed per ecosystem.

### History

**Store**:
The local data on disk: the snapshot log plus everything derived from it.
_Avoid_: database, cache (the cache is the refetchable part of the store)

**Snapshot**:
One measurement of one target at one time, appended to the log and never rewritten.
_Avoid_: record, sample

**Delta**:
The change in a metric since the baseline. `null` means unknown, shown as **new**, never zero.

**Baseline**:
The newest snapshot at least one delta window older than the current one.
_Avoid_: previous, yesterday

**Delta window**:
The minimum age of a baseline, per ecosystem.

**Series**:
A target's per-day download counts, as the ecosystem serves them.

**Curve**:
A repo's star history, with its most recent stargazers.

**Release track**:
The npm versions sharing a prerelease word, such as `next`; versions with none are `stable`.

### Freshness

**Refresh**:
The one bulk fetch: discover every target, fetch each, append a snapshot per target.
_Avoid_: sync, update, pull

**Fresh read**:
A `--fresh` fetch of one named target, which also appends a snapshot.

**Discovery**:
Finding an account's targets in an ecosystem, before any is fetched.

**Roster**:
An ecosystem's authoritative list of what an account publishes, as opposed to search results.

**TTL**:
How long a target's values count as current, per ecosystem.

**Stale**:
Older than its TTL, or carried forward from a failed fetch.
_Avoid_: outdated, expired

**Retired**:
A target that was deleted, unpublished, made private or transferred. It keeps its history and returns if discovery finds it again. A project is never retired as such; it leaves the dashboard once all its targets have.
_Avoid_: removed, deleted, archived (archived is a separate GitHub state)

**Drift**:
A project-level disagreement the data reveals: ecosystems on different versions, or work pushed after the last release.

### Dashboard

**Dashboard**:
The TUI's main screen: one pane per group of ecosystems, one row per project in each.

**Pane**:
One bordered section of the dashboard, with its own columns: GitHub, registries, extensions or skills.
_Avoid_: domain, panel (the sources panel is not a pane)

**Detail overlay**:
The dashboard's full view of one project.

**Accounts screen**:
The TUI screen that sets one account per ecosystem.

## Flagged ambiguities

- "Store" meant both the local data and a publishing service. It now means only the local data; a service is named by its ecosystem, and skills.sh is the index.
- "Registry" meant both any ecosystem's server and the package and container registries. It now means only those.
- "Retired" was said of projects. Only a target is retired.
