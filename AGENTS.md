# AI project guidelines

`quadraplex`: portfolio monitor over everything `shbernal` publishes. Collects npm, PyPI
and GitHub state into a local append-only store, then serves it to agents as JSON and to
humans as an Ink TUI.

- Key commands
  - `bun test`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run knip`
  - `qplex` (symlinked to `bin/quadraplex`, same entrypoint as the published CLI)
  - `bun run scripts/render-dashboard.ts <cols> <rows> [keys]` after any TUI change

- Domain terms are defined in [GLOSSARY.md](GLOSSARY.md). Use them in code, comments and
  conversation, and never use a word listed under `_Avoid_` for a domain term.

- Key documentation
  - [CONTRIBUTING.md](CONTRIBUTING.md): workflow, layout, conventions
  - [docs/architecture.md](docs/architecture.md): data model, store, freshness rules
  - [docs/commands.md](docs/commands.md): the command surface and its JSON contract
  - [docs/github.md](docs/github.md): rate limits, the issue and PR split, star curves
  - [docs/adr/](docs/adr/): decisions already made, with when to revisit them
  - [skills/quadraplex/SKILL.md](skills/quadraplex/SKILL.md): what agents are taught, pinned to `schemaVersion`

- Hard contracts
  - Breadth comes from cache, freshness comes from a target. `refresh` is the only bulk
    fetcher. `status` and `list` never touch the network, and `--fresh` on them is an
    error that names `refresh`.
  - Public data only. A GitHub token improves rate limits and is never required. A feature
    that cannot degrade honestly without one does not ship.
  - `snapshots.jsonl` is the source of truth and append-only. `state.json`, `cache.json`
    and `curves/` are derived or rebuildable, and deleting them must cost requests, never
    data.
  - `deltas: null` means unknown, not zero. Render it as "new".
  - The TUI never fetches. It reads the store and shells out to `refresh`.

- Iron Laws
  - Tokens are expensive, state of the art models need minimal guidance, don't repeat yourself, don't babysit, don't be over-specific.
  - AI-native project. All code is AI-generated.
  - Minimal attention when model implements without errors, we document in more detail when model struggles.
  - Do not expect the user to have read each line, don't lose him on the internals, give visibility on a higher-architectural level.
  - No journaling: code comments / documentation describe current state, they don't carry a log of their own edit history.
