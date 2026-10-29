# Command surface

Exit codes: `0` success, `1` runtime failure, `2` usage error.

Every JSON payload carries `schemaVersion`, and every target inside one carries
`fetchedAt` and `stale`.

## `qplex`

With a TTY, opens the dashboard, or the accounts screen when there is no config yet.
Piped or redirected, prints the `status` table instead and never enters raw mode.
`--fresh` is a usage error, as on `status`.

## `qplex init --<ecosystem> <account> [--json]`

Sets accounts in the config without a prompt: `qplex init --github me --npm me`. Every
other key in the file is kept, and an empty value (`--npm ''`) removes that account. The
result is validated like a load and replaces the file in one rename, creating its
directory first. The payload is the config path and the accounts now set. With no
account flag and no `--suggest`, a TTY opens the accounts screen prefilled from the
config, and anything else is a usage error.

## `qplex init --suggest [--handle <name>] [--<ecosystem> <account>] [--only <ecosystem>] [--json]`

Proposes an account per ecosystem and asks each ecosystem what it holds for it. The handle
is the gh login from `hosts.yml` (under `GH_CONFIG_DIR` or the XDG config dir), else
`git config github.user`, never `user.name`. `--handle` replaces it, `--npm <x>` and its
siblings probe a typed value for one ecosystem, and `--only` limits the run to one row.

Each suggestion carries `value`, `source` (`gh`, `git`, `handle`, `typed` or null),
`status` and, once probed, `count`. `found` means the ecosystem holds something for the
account, and `none` covers both an unknown account and an empty one. `unchecked` means
the ecosystem could not be reached, with `reason`, and is never an error exit. The count
is what discovery would find, except on GitHub, where it is the public repo count, and on
AMO, where the accounts API turns a username or id into the numeric id discovery keys on
and adds the display name as `label`. AMO no longer issues usernames, so a handle it does
not know is matched against add-on authors' display names; a single match is suggested
with `label` saying so, several or none is `none`.

## `qplex refresh [--only npm|pypi|github|gh|ghcr|dockerhub|docker|rubygems|gem|jsr|amo|cws|clawhub] [--curves]`

The only command that walks the portfolio. Discovers targets, fetches each one, appends
one snapshot line per target, then rewrites `state.json`. With no account and no `include`
configured it is a usage error.

A failing target keeps its previous values and gains an `errors` entry. A failing
discovery is reported under `discoveryFailed`, and that ecosystem's refresh falls back to
the targets the store already knows plus config `include`. Each ecosystem is persisted as
soon as it finishes, so a later failure never discards an earlier one. The command exits
non-zero only when something failed and nothing succeeded.

A run has a five-minute ceiling. Past it no new request starts, targets not yet fetched
carry forward as failed with a deadline error, and requests already in flight finish
within their own per-attempt timeout.

A target that left the portfolio is retired and listed under `retired` with its reason.
It drops out of every read and is no longer fetched, and `qplex <eco> <target>` says when
and why. Discovery finding it again brings it back. See retirement in
[architecture.md](architecture.md#retirement).

`--curves` rebuilds star history instead of the routine metrics. It is separate because a
curve costs about 17 requests per repo, which would consume an unauthenticated GitHub
budget in a single command. A repo whose stored star count is unknown is listed under
`unknown` and gets no curve until a routine refresh has counted it.

It also harvests the most recent stargazer logins, which ride in on the pages the curve is
sampled from and add no requests. They are what the dashboard's detail overlay lists.

## `qplex status [--json]`

A compact index of everything, from cache. Per target: id, ecosystem, name, how it was
discovered, one headline metric, its delta and baseline, `changed`, `stale`, `fetchedAt`.

The payload also carries `discovery` per ecosystem, `auto` or `config` or `empty`, and
`hints` for the cases where an empty section would otherwise read as "you have nothing
here". An install with no config file gets a single hint to set up its accounts instead.

`--fresh` is a usage error.

## `qplex list <ecosystem> [--json]`

One ecosystem, names plus a one-line state each, from cache. `--fresh` is a usage error.

## `qplex npm <pkg> | pypi <pkg> | gh <owner/repo> | ghcr <owner/image> | dockerhub <namespace/image> | rubygems <gem> | jsr <@scope/pkg> | amo <slug> | cws <id> | clawhub <slug> [--json] [--fresh]`

One target in full: every metric, every delta, the download or star series when there is
one, and the GitHub issue and PR detail used by the dashboard's detail overlay. An npm
target also carries `versions`, the week's downloads per version that the overlay splits
into release tracks.

`--fresh` refetches that one target and appends a snapshot, so a targeted fresh read still
becomes history. It skips every cache a routine refresh trusts, GitHub releases included.
A target the config hides (archived, fork, deprecated or excluded) is still fetched and
stored, then rejected with a usage error naming the setting that hides it. AMO resolves old
slugs, so the payload carries the canonical id, which can differ from the name typed.

## `qplex completions bash`

Prints a bash completion script for `qplex` and `quadraplex`. Target names come from the
hidden `qplex __complete <ecosystem>`, which lists what the store holds and never fetches.

## The JSON contract for agents

Read `state.json` directly for breadth. It costs no process start and no network. Use
`status --json` when you want the index rather than the whole store, and a targeted
command when you already know what you are looking at.

Two fields are easy to misread:

- `deltas` is `null` on a first run and means unknown, not zero. It is measured against
  `deltaBaselineAt`, not against yesterday.
- `stale` is a computed TTL verdict. Trust it rather than re-deriving it from `fetchedAt`.
