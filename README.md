# quadraplex

One monitor for everything you publish. npm packages, PyPI packages and GitHub repos land
in a single local store, and quadraplex tells you what moved since last time.

Named after the Quadraplex T-3000, the computer that oversees the lab in _Dexter's
Laboratory_. It reports on the facility. It does not run it.

## What it gives you

- **Deltas, not just numbers.** Every metric is shown against a time anchored baseline, so
  you read "+120 downloads since Aug 19" instead of a total you have to remember.
- **A dashboard that opens instantly.** The TUI reads the local store and never fetches,
  so it works offline and never stalls on a slow registry.
- **One row per project.** A package and its repo are the same thing to you, so downloads
  and stars share a line.
- **A JSON surface built for agents.** A cached snapshot answers most questions with no
  network at all, and only targeted lookups are allowed to refetch.

## Install

```sh
npm install -g quadraplex
```

Two commands are installed, `quadraplex` and `qplex`. They are the same tool.

## Use it

```sh
qplex refresh     # the only command that hits the network
qplex             # open the dashboard
```

`refresh` discovers your npm packages and public GitHub repos from your account name.
PyPI has no public per-user listing, so those packages are named in the config file.

Config lives at `~/.config/quadraplex/config.json` and every key is optional:

```jsonc
{
  "accounts": { "npm": "you", "pypi": "you", "github": "you" },
  "include": ["pypi:your-package"],
}
```

In the dashboard, `r` refreshes, `o` opens the selected project in a browser, `enter`
opens a detail view, and `q` quits.

## For agents

Point your agent at the snapshot, not at the network:

```sh
qplex status --json          # compact index of everything, cache only
qplex npm your-pkg --json    # one target, add --fresh to refetch just that one
```

`--fresh` requires a target on purpose. There is no way to refetch the whole portfolio
through the JSON surface, because that is how rate limits die.

## License

MIT
