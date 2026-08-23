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
bun run format
bun run build          # bundles for node, which is what npm ships
```

`QUADRAPLEX_DATA_DIR` points the store somewhere else, which is how the tests get an
isolated one. `QUADRAPLEX_DEBUG_HTTP=1` traces every request with its status and remaining
rate limit, which is how conditional-request behaviour is checked.

After any change to the dashboard, render a frame instead of squinting at a terminal:

```sh
bun run scripts/render-dashboard.ts 100 24        # a frame at a fixed size
bun run scripts/render-dashboard.ts 80 20 $'G\r'  # replay keys first
```

The pre-commit hook runs the same checks on staged files, plus a prose check on the
documents a user reads and a block on AI attribution lines in commit messages.

## Layout

```
src/
  bin.ts          entrypoint, argument parsing, command dispatch
  core/           types, config, store, deltas, staleness
  sources/        one module per ecosystem, fetch and normalize only
  commands/       one module per CLI command, store in, payload out
  tui/            Ink components, read-only
skills/           the agent-facing skill that ships with the CLI
```

Two rules shape most of the code:

- Only `refresh` fetches in bulk. Everything else reads the store or fetches exactly one
  target.
- `snapshots.jsonl` is append-only history. Anything else in the data directory is
  rebuildable from the network and must never hold the only copy of a number.

## Adding an ecosystem

Write a module under `src/sources/` that exports a discovery function and a fetch
function returning `Target` objects. Register it in the source registry. The store, the
delta engine, the JSON surface and the TUI are ecosystem agnostic and should need no
changes.
