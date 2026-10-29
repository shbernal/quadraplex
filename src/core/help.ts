export const HELP = `quadraplex, a portfolio monitor for what you publish

Usage
  qplex                        open the dashboard, or the accounts screen on a first run
  qplex init                   choose your accounts on a screen that probes each ecosystem
  qplex init --suggest         find your accounts from gh or git and probe each ecosystem
  qplex init --<ecosystem> <x> set an account, keeping the rest of the config, '' removes it
  qplex refresh [options]      fetch everything, the only command that hits the network
  qplex status [--json]        compact index of every target, cache only
  qplex list <ecosystem>       one ecosystem, names plus one-line state, cache only
  qplex npm <pkg>              one npm package
  qplex pypi <pkg>             one PyPI package
  qplex gh <owner/repo>        one GitHub repo
  qplex ghcr <owner/image>     one container image on ghcr.io
  qplex dockerhub <ns/image>   one container image on Docker Hub, alias docker
  qplex rubygems <gem>         one RubyGems gem, alias gem
  qplex jsr <@scope/pkg>       one JSR package
  qplex amo <slug>             one Firefox add-on
  qplex cws <id>               one Chrome extension
  qplex clawhub <slug>         one ClawHub skill
  qplex vscode <pub.name>      one VS Code extension on the Visual Studio Marketplace
  qplex openvsx <ns.name>      one VS Code extension on Open VSX
  qplex completions bash       print a bash completion script

Ecosystems
  npm                          npm packages
  pypi                         PyPI packages
  github, gh                   GitHub repos, their releases and skills
  ghcr                         container images, ghcr.io
  dockerhub                    container images, Docker Hub
  rubygems, gem                Ruby gems, RubyGems
  jsr                          JSR packages, jsr.io
  amo                          Firefox add-ons, addons.mozilla.org
  cws                          Chrome extensions, Chrome Web Store
  clawhub                      agent skills published on ClawHub
  vscode                       VS Code extensions, Visual Studio Marketplace
  openvsx                      VS Code extensions, Open VSX

Options
  --json                       machine-readable output
  --fresh                      refetch, allowed only on a single target
  --only <ecosystem>           refresh one ecosystem only
  --curves                     star curves and recent stargazers, never touched by a plain refresh
  --handle <name>              init: the handle to probe instead of the detected one
  --<ecosystem> <account>      init: the account to set, or with --suggest to probe
  --version, --help

Breadth comes from cache, freshness comes from a target. status and list never fetch, and
refresh is the only command that walks the whole portfolio.`
