export const HELP = `quadraplex, a portfolio monitor for what you publish

Usage
  qplex                        open the dashboard, or print the status table when piped
  qplex refresh [options]      fetch everything, the only command that hits the network
  qplex status [--json]        compact index of every target, cache only
  qplex list <ecosystem>       one ecosystem, names plus one-line state, cache only
  qplex npm <pkg>              one npm package
  qplex pypi <pkg>             one PyPI package
  qplex gh <owner/repo>        one GitHub repo
  qplex amo <slug>             one Firefox add-on
  qplex cws <id>               one Chrome extension

Options
  --json                       machine-readable output
  --fresh                      refetch, allowed only on a single target
  --only <ecosystem>           refresh one of npm, pypi, github, amo, cws
  --curves                     refresh only star curves, never touched by a plain refresh
  --version, --help

Breadth comes from cache, freshness comes from a target. status and list never fetch, and
refresh is the only command that walks the whole portfolio.`
