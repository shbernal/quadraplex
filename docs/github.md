# GitHub

Public data only. A token improves rate limits and is never required.

Token resolution, in order: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token` when the
GitHub CLI is installed and logged in. Without any of them the client is anonymous.

## What a refresh costs

Discovery is `GET /users/<user>/repos?type=owner&per_page=100`, and the repo objects it
returns already carry stars, forks, `open_issues_count`, `pushed_at`, `default_branch` and
`archived`. So a portfolio of any size costs one request per hundred repos for the
metrics, and one extra request only for a repo that has something open and is not being
filtered out by `includeArchived` or `includeForks`. Releases add one request per kept repo
per day, below.

ETags live in `cache.json`, keyed per endpoint, and a 304 counts as a successful
verification: the stored numbers are current, so `fetchedAt` advances without a transfer. A
304 with no stored snapshot behind it is a cache miss and is asked again unconditionally.

A 304 is only free with a token. GitHub exempts it from the rate limit only when the request
carried an `Authorization` header, so an anonymous 304 still spends one of the 60 hourly
requests. It saves the transfer, not the quota.

## Archived repos and forks

Neither is something you publish, so both are dropped from `state.json` by default and
never reach `status`, `list` or the dashboard. `archived` and `fork` are recorded on every
snapshot, `includeArchived` and `includeForks` bring them back, and the log keeps their
history either way.

They are still refreshed, which costs nothing beyond the discovery page they already ride
in on: their issue lists are never read and their star curves are never built.

## The issue and pull request split

`open_issues_count` counts pull requests as issues. Rather than paying for a search query
per repo, the split comes from one `GET /repos/<repo>/issues?state=open&per_page=100` call
on repos that have open items, which returns issues and pull requests together and marks
the latter. That works without a token and pays for the detail overlay in the same request.

When a repo has more open items than a single page holds, the split is reported as
`null` and only `openIssuesAndPRs` is shown, labelled as the combined count. The combined
number is never presented as an issue count.

## Releases

`GET /repos/<repo>/releases?per_page=100` once per repo per `releases` TTL, 24h by default,
and sooner when `pushed_at` is newer than the stored reading, since publishing a tag is a
push. The hourly refresh otherwise reuses `releases/<id>.json`, so an anonymous portfolio
of 40 repos spends 40 requests a day on releases, not 40 an hour. The first page is
conditional, so with a token an unchanged reread is a free 304.

A release CI creates after the tag push can miss a refresh that lands in between, and
that reading then stands until the TTL. `qplex gh <repo> --fresh`, and `r` in the
dashboard's detail overlay, reread releases unconditionally.

Each reread also spends `GET /repos/<repo>/compare/<tag>...<default branch>` on
`unreleasedCommits`. The count only moves with a push or a release, the same triggers.

Drafts are never counted. Prereleases count toward `downloadsTotal` but never become
`version`. Checksums, signatures and SBOMs are left out of the total, because every
verified download fetches them alongside the binary and would double it.

## Skills

The repo's tree, `GET /repos/<repo>/git/trees/<branch>?recursive=1`, is read when nothing
is stored and again whenever `pushed_at` is newer than the stored reading, since a skill
only changes with a push. The SKILL.md paths are chosen by the skills CLI's own rules, and
each one is read from raw.githubusercontent.com, outside the API's rate limit, only when
its blob sha changed. Frontmatter supplies the name, and a skill without a name and
description, or marked `metadata.internal`, is not one the CLI would install.

Install counts come from one skills.sh search per account per refresh,
`/api/search?owner=<account>`, which needs no key. It caps at 200 results. A skill it does
not list has `installs: null`, and an index that fails to answer keeps the last counts
rather than failing the repo.

## Watchers

Not reported. The list endpoint returns `watchers_count` as a copy of `stargazers_count`,
and the real subscriber count needs one request per repo. A duplicated number is worse
than an absent one.

## Star curves

`refresh --curves` only, never a plain refresh. A curve is about 17 requests, so rebuilding
a 40 repo portfolio inside the routine command would spend an anonymous hourly budget in
one go. Curves have their own 30 day TTL and repos with no stars are skipped rather than
requested.

The algorithm is ported from star-history/star-history, attributed in `LICENSE`. Sampling
keeps the cost flat: about 17 requests whether a repo has 200 stars or 200,000.

Three details are load bearing:

- `Accept: application/vnd.github.v3.star+json` is mandatory. Without that exact media
  type the endpoint returns user objects with no `starred_at` at all, and it fails
  silently.
- Two code paths by size. Under about 1600 stars every page is fetched and the flattened
  list is strided, where the cumulative count is `index + 1`. Above that, evenly spaced
  pages are sampled and only their first entry shapes the curve, where the cumulative
  count is `100 * (page - 1)`. Page 1 is forced into the sample set either way.
- The live `stargazers_count` is appended as the final point. The sampling arithmetic tops
  out below the real total, so without it every curve ends wrong.

The curve points have no consumer yet and sit on disk for whenever a chart lands. The
identities harvested alongside them do, in the dashboard's detail overlay.

### Who starred

Every `/stargazers` page returns the user object next to `starred_at`, so the logins
behind the curve arrive in responses already paid for and cost nothing on top of it. The
most recent 100 are stored on the curve as `stargazers` and shown in the detail overlay.

Both sampling paths reach the tail. The small path walks every page, and the large path
always samples the last one, which is where the newest stargazers sit.

`stargazers` absent on a curve means nobody harvested it, not that nobody starred. On a
large repo the roster only ever covers the tail: `metrics.stars` remains the total, and
the pane labels the list as recent rather than complete.

Logins only. The stargazers endpoint returns GitHub's simple user shape, which carries
`login` and `html_url` but no display name, bio or follower count. Those need one
`GET /users/<login>` per person, so resolving them belongs behind its own flag and its
own TTL rather than riding along here.

### Untested against a large repo

The sampling arithmetic is unit tested, and the fetcher is verified end to end against
repos on the small path. The large repo path has not been exercised against live data:
this machine's network answers `/stargazers` with 404 for repos the account does not own,
and 401 when anonymous, so no repo above the 1600 star threshold was reachable.

GitHub also clamps how far list endpoints paginate, and nothing upstream handles it. If
that clamp applies to `/stargazers`, the page count read from the `Link` header is capped
for very large repos and the curve silently compresses. Both are worth confirming from a
network that can reach third-party repos.
