# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version stays below 1.0.0, a minor release may make a breaking change, and says so
against every entry that does. A patch release does not.

## [Unreleased]

## [0.1.0]

First release on npm, installed with `npm install -g quadraplex`. It runs on Node 24 or newer
and needs no bun.

### Added

- **One local store for what you publish.** npm, JSR, PyPI, Packagist, NuGet, AUR, RubyGems,
  crates.io, ghcr.io, Docker Hub, Firefox Add-ons, the Chrome Web Store, the VS Marketplace,
  Open VSX, ClawHub and GitHub repos, discovered from your account on each.
- **`qplex refresh`**, the only command that fetches in bulk. It appends to
  `snapshots.jsonl`, the append-only source of truth.
- **A dashboard** that reads the store and never fetches, with deltas against a baseline,
  drift between ecosystems and a sources panel for data age. The first launch opens an
  accounts screen prefilled from your gh or git login.
- **A JSON surface for agents.** `status` and `list` answer from cache, and a single target
  may refetch with `--fresh`. The payloads carry a `schemaVersion`.
- **An agent skill**, installed with `npx skills add shbernal/quadraplex`.
- Bash completion through `qplex completions bash`.

[Unreleased]: https://github.com/shbernal/quadraplex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shbernal/quadraplex/releases/tag/v0.1.0
