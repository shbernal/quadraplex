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
