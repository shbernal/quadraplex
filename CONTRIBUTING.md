# Contributing

Issues and pull requests are welcome, including fully AI-generated ones.

## AI disclosure

If AI wrote part of a contribution, say so in the issue or pull request body, and name the
harness and the model. That is the whole requirement. There is no penalty attached to it,
and the project itself is AI-generated.

## Setup

```sh
bun install
bun run lefthook install
```

## Checks

```sh
bun test
bun run typecheck
bun run lint
bun run knip           # unused files and exports, too slow for the commit hook
bun run format
bun run build          # bundles for node, which is what npm ships
```

`QUADRAPLEX_HOME` points the store somewhere else, which is how the tests get an
isolated one. `QUADRAPLEX_DEBUG_HTTP=1` traces every request with its status and remaining
rate limit, which is how conditional-request behaviour is checked. `QUADRAPLEX_DEBUG=1` adds
the stack to a runtime error, under the message and its causes that are always printed.

After any change to the dashboard, render a frame instead of squinting at a terminal:

```sh
bun run scripts/render-dashboard.ts 100 24        # a frame at a fixed size
bun run scripts/render-dashboard.ts 80 20 $'G\r'  # replay keys first
```

The README demo is `scripts/demo.tape`, recorded against your own store with
`scripts/demo.sh`. It needs VHS, ffmpeg and a Nerd Font, and refreshes first so the ages
read fresh.

Before publishing, and after any change to onboarding or packaging, run the first-install
smoke test:

```sh
cp .env.example .env    # then set QPLEX_SMOKE_HANDLE, and any per-ecosystem account
scripts/smoke-install.sh
```

It packs the tarball and installs it in a `node:24-slim` container with no bun, token, gh
login or config, then checks a bare install, a handle seeded from a fake gh `hosts.yml`
and from `git config github.user`, and a scripted `init` plus `refresh`. An ecosystem the
handle has no account on is skipped, not failed. With [VHS](https://github.com/charmbracelet/vhs)
installed it also records the first run, the handle typed into the GitHub row through to
the dashboard, as text in `dist/first-run.txt`.

The pre-commit hook runs the same checks on staged files, plus a prose check on the
documents a user reads and a block on AI attribution lines in commit messages.

## Layout

```
src/
  bin.ts          entrypoint, argument parsing, command dispatch
  core/           types, config, store, deltas, staleness
  sources/        one module per ecosystem, fetch and normalize only
  commands/       one module per CLI command, store in, payload out
  tui/            the dashboard: board (data), frame (layout), detail, read-only
skills/           the agent-facing skill that ships with the CLI
docs/             reference docs and ADRs, named in lowercase kebab-case
```

Two rules shape most of the code:

- Only `refresh` fetches in bulk. Everything else reads the store or fetches exactly one
  target.
- `snapshots.jsonl` is append-only history. Anything else in the data directory is
  rebuildable from the network and must never hold the only copy of a number.

## Adding an ecosystem

Write a module under `src/sources/` that exports a discovery function and a fetch
function returning `Target` objects. Add it to the `sources` table in `src/sources/all.ts`. The store, the
delta engine, the JSON surface and the TUI are ecosystem agnostic and should need no
changes.
