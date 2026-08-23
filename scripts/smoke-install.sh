#!/usr/bin/env bash
# First-install smoke test: installs the packed tarball in a container that has no bun,
# token, gh, npm login or config, and walks the paths a stranger takes. Nothing from the
# host's gh config is mounted, since it holds an OAuth token. Inputs: .env.example.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
: "${QPLEX_SMOKE_HANDLE:?set QPLEX_SMOKE_HANDLE to a handle that publishes somewhere, in .env (see .env.example) or the environment}"

IMAGE=qplex-smoke
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tarball=$(npm pack --silent --pack-destination "$work" | tail -1)
docker build --quiet -t "$IMAGE" -f - "$work" >/dev/null <<DOCKERFILE
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY $tarball /tmp/
RUN npm install --global /tmp/$tarball && rm /tmp/$tarball
USER node
WORKDIR /home/node
DOCKERFILE

# Sourced ahead of every scenario. `check` asserts a JavaScript expression over the JSON
# on stdin, bound to d, and prints the payload when it does not hold.
PRELUDE='
set -euo pipefail
H=$QPLEX_SMOKE_HANDLE
fail() { echo "FAIL: $*" >&2; exit 1; }
check() {
  node -e "const d = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\"))
    if (!($1)) { console.error(process.argv[1]); console.error(JSON.stringify(d, null, 2)); process.exit(1) }" "FAIL: $2"
}
'

# Each scenario is a fresh container, so no state leaks from one into the next.
run() {
  echo "== $1"
  printf '%s\n%s\n' "$PRELUDE" "$2" | docker run --rm -i \
    -e QPLEX_SMOKE_HANDLE -e QPLEX_SMOKE_NPM -e QPLEX_SMOKE_PYPI \
    -e QPLEX_SMOKE_AMO -e QPLEX_SMOKE_CWS \
    "$IMAGE" bash -s
  echo "   ok"
}

run bare '
qplex --help >/dev/null
qplex status | grep -q "qplex init" || fail "status does not point to init"
if qplex refresh 2>err; then fail "refresh ran with no accounts"; fi
grep -q "qplex init" err || fail "refresh does not name init"
qplex init --suggest --json | check "d.suggestions.every((s) => s.value === null)" "rows were seeded from nothing"
'

# A handle with no account on some registry finds nothing there, which is not a failure.
seeded() {
  printf '%s\n' "qplex init --suggest --json | check \"d.suggestions.every((s) => s.source === '$1') && d.suggestions.some((s) => s.status === 'found')\" \"rows were not seeded from $1, or found nothing\""
}
run seeded-gh "
mkdir -p ~/.config/gh
printf 'github.com:\n    user: %s\n' \"\$H\" > ~/.config/gh/hosts.yml
$(seeded gh)"
run seeded-git "
git config --global github.user \"\$H\"
$(seeded git)"

run scripted '
flags=(--github "$H")
for e in npm pypi amo cws; do
  var="QPLEX_SMOKE_${e^^}"
  if [[ -n "${!var:-}" ]]; then flags+=("--$e" "${!var}"); fi
done
qplex init --suggest --json "${flags[@]}" |
  check "d.suggestions.filter((s) => s.source === \"typed\").every((s) => s.status === \"found\")" \
    "a provided account found nothing"
qplex init "${flags[@]}" >/dev/null
qplex refresh >/dev/null
qplex status --json |
  check "typeof d.schemaVersion === \"number\" && d.targets.length > 0" "status is empty after refresh"
'

if command -v vhs >/dev/null; then
  out=$PWD/dist/first-run.txt
  mkdir -p dist
  sed -e "s|{{HANDLE}}|$QPLEX_SMOKE_HANDLE|" -e "s|{{IMAGE}}|$IMAGE|" -e "s|{{OUTPUT}}|$out|" \
    scripts/first-run.tape.tmpl >"$work/first-run.tape"
  echo "== first-run recording"
  vhs --quiet "$work/first-run.tape"
  echo "   $out"
else
  echo "== first-run recording skipped, vhs is not installed"
fi
