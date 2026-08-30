# quadraplex

One monitor for everything you publish. npm packages, PyPI packages, browser extensions
and GitHub repos land in a single local store, and quadraplex tells you what moved since
last time.

Named after the Quadraplex T-3000, the computer that oversees the lab in _Dexter's
Laboratory_. It reports on the facility. It does not run it.

## What it gives you

- **Deltas, not just numbers.** Every metric is shown against a time anchored baseline, so
  you read "+120 downloads since Aug 19" instead of a total you have to remember.
- **A dashboard that opens instantly.** The TUI reads the local store and never fetches,
  so it works offline and never stalls on a slow registry.
- **One row per project.** A package and its repo are the same thing to you, so downloads
  and stars share a line, and a fixed slot per store says where a project is published.
- **Drift between stores.** When Chrome is on 1.4.0 and Firefox is on 1.4.1, the row says
  so, and a default branch pushed long after the last release shows as unreleased work.
  Both readings come out of the store, so neither costs a request.
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

`refresh` discovers your npm packages, Firefox add-ons and public GitHub repos from your
account name. AMO keys on the numeric author id, which is what its API accepts.
PyPI and the Chrome Web Store publish no per-developer listing, so those packages and
extensions are named in the config file.

Config lives at `~/.local/share/quadraplex/config.json` and every key is optional:

```jsonc
{
  "accounts": { "npm": "you", "pypi": "you", "github": "you", "amo": "123456" },
  "include": ["pypi:your-package", "cws:your32letterextensionid"],
  "includeArchived": false,
  "includeForks": false,
}
```

Archived repos and forks are left out of every view by default, since neither is something
you publish. Set either key to `true` to count them again.

In the dashboard, `/` filters, `e` scopes the list to one store, `s` cycles the sort and
`c` clears all three. `enter` opens a project, `o` opens the thing under the cursor in a
browser, `r` refreshes whatever is scoped, and `?` lists every key. `q` quits.

## For agents

Point your agent at the snapshot, not at the network:

```sh
qplex status --json          # compact index of everything, cache only
qplex npm your-pkg --json    # one target, add --fresh to refetch just that one
```

`--fresh` requires a target on purpose. There is no way to refetch the whole portfolio
through the JSON surface, because that is how rate limits die.

An installable skill teaches an agent that access strategy directly:

```sh
npx skills add shbernal/quadraplex
```

## License

MIT
