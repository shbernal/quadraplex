import { UsageError } from '../core/args.ts'
import { loadConfig } from '../core/config.ts'
import { loadState } from '../core/store.ts'
import { ecosystemNamed } from '../core/types.ts'
import { TARGET_COMMANDS } from './target.ts'

export function completionScript(shell: string | undefined): string {
  if (shell !== 'bash')
    throw new UsageError('completions supports bash, as "qplex completions bash"')
  const targets = Object.keys(TARGET_COMMANDS).join('|')
  return `# bash completion for qplex and quadraplex
_qplex() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" cmd="\${COMP_WORDS[1]}"
  local ecosystems="npm pypi github gh ghcr dockerhub docker rubygems gem jsr packagist composer nuget amo cws clawhub vscode openvsx aur"
  COMPREPLY=()

  if [[ "$prev" == --only ]]; then
    COMPREPLY=( $(compgen -W "$ecosystems" -- "$cur") )
    return
  fi
  if [[ "$cur" == -* ]]; then
    local flags="--json --help --version"
    case "$cmd" in
      refresh) flags="--json --only --curves" ;;
      init) flags="--suggest --json --only --handle --npm --pypi --github --ghcr --amo --cws --clawhub --dockerhub --rubygems --jsr --vscode --openvsx --aur --packagist --nuget" ;;
      status|list) flags="--json" ;;
      ${targets}) flags="--json --fresh" ;;
    esac
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
    return
  fi
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "init refresh status list npm pypi gh ghcr dockerhub docker rubygems gem jsr packagist composer nuget amo cws clawhub vscode openvsx aur completions help" -- "$cur") )
    return
  fi
  (( COMP_CWORD == 2 )) || return
  case "$cmd" in
    list) COMPREPLY=( $(compgen -W "$ecosystems" -- "$cur") ) ;;
    completions) COMPREPLY=( $(compgen -W "bash" -- "$cur") ) ;;
    ${targets})
      local name
      while IFS= read -r name; do
        [[ "$name" == "$cur"* ]] && COMPREPLY+=( "$name" )
      done < <("\${COMP_WORDS[0]}" __complete "$cmd" 2>/dev/null)
      ;;
  esac
}
complete -F _qplex qplex quadraplex`
}

/** Names the store already knows, read from cache so a keystroke never costs a request. */
export function completionNames(value: string | undefined): string[] {
  const ecosystem = ecosystemNamed(value)
  if (!ecosystem) return []
  return loadState(loadConfig())
    .targets.filter((t) => t.ecosystem === ecosystem)
    .map((t) => t.name)
    .toSorted()
}
