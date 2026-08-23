# GitHub

Public data only. A token improves rate limits and is never required.

Token resolution, in order: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token` when the
GitHub CLI is installed and logged in. Without any of them the client is anonymous.

## What a refresh costs

Discovery is `GET /users/<user>/repos?type=owner&per_page=100`, and the repo objects it
returns already carry stars, forks, `open_issues_count`, `pushed_at`, `default_branch` and
`archived`. So a portfolio of any size costs one request per hundred repos for the
metrics, and one extra request only for a repo that has something open and is not being
filtered out by `includeArchived` or `includeForks`.

ETags live in `cache.json`, keyed per endpoint, and a 304 counts as a successful
verification: the stored numbers are current, so `fetchedAt` advances without a transfer.

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
the latter. That works without a token and pays for the detail modal in the same request.

When a repo has more open items than a single page holds, the split is reported as
`null` and only `openIssuesAndPRs` is shown, labelled as the combined count. The combined
number is never presented as an issue count.

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
  pages are sampled and only their first entry is read, where the cumulative count is
  `100 * (page - 1)`. Page 1 is forced into the sample set either way.
- The live `stargazers_count` is appended as the final point. The sampling arithmetic tops
  out below the real total, so without it every curve ends wrong.

The fetcher has no consumer in v1. It puts the curve on disk for whenever a chart lands.

### Untested against a large repo

The sampling arithmetic is unit tested, and the fetcher is verified end to end against
repos on the small path. The large repo path has not been exercised against live data:
this machine's network answers `/stargazers` with 404 for repos the account does not own,
and 401 when anonymous, so no repo above the 1600 star threshold was reachable.

GitHub also clamps how far list endpoints paginate, and nothing upstream handles it. If
that clamp applies to `/stargazers`, the page count read from the `Link` header is capped
for very large repos and the curve silently compresses. Both are worth confirming from a
network that can reach third-party repos.
