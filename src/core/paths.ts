import { homedir } from 'node:os'
import { join } from 'node:path'

type Kind = 'config' | 'data' | 'cache'

const XDG: Record<Kind, [variable: string, fallback: string]> = {
  config: ['XDG_CONFIG_HOME', '.config'],
  data: ['XDG_DATA_HOME', join('.local', 'share')],
  cache: ['XDG_CACHE_HOME', '.cache'],
}

function xdgVar(kind: Kind): string | undefined {
  const value = process.env[XDG[kind][0]]
  return value?.startsWith('/') ? value : undefined
}

/**
 * XDG on Linux, or anywhere an XDG variable is set: config, history and refetchable
 * files each go to their own base directory. Elsewhere everything shares
 * `~/.quadraplex`, and `QUADRAPLEX_HOME` forces that single-directory layout at a
 * chosen root.
 */
function dir(kind: Kind): string {
  const home = process.env.QUADRAPLEX_HOME
  if (home) return home
  const kinds = Object.keys(XDG) as Kind[]
  if (process.platform !== 'linux' && !kinds.some(xdgVar)) return join(homedir(), '.quadraplex')
  return join(xdgVar(kind) ?? join(homedir(), XDG[kind][1]), 'quadraplex')
}

export const paths = {
  get config() {
    return join(dir('config'), 'config.json')
  },
  get snapshots() {
    return join(dir('data'), 'snapshots.jsonl')
  },
  get state() {
    return join(dir('data'), 'state.json')
  },
  get cache() {
    return join(dir('cache'), 'cache.json')
  },
  curve(id: string) {
    return perTarget('curves', id)
  },
  series(id: string) {
    return perTarget('series', id)
  },
  detail(id: string) {
    return perTarget('detail', id)
  },
  releases(id: string) {
    return perTarget('releases', id)
  },
  skills(id: string) {
    return perTarget('skills', id)
  },
}

function perTarget(sub: string, id: string): string {
  return join(dir('cache'), sub, `${fileName(id)}.json`)
}

/**
 * Reversible, so two ids never share a file. Safe characters pass through and every other
 * UTF-8 byte, `_` included, becomes `_` and two hex digits: `npm:@scope/name` is
 * `npm_3a_40scope_2fname`.
 */
export function fileName(id: string): string {
  let out = ''
  for (const char of id) {
    if (/[a-zA-Z0-9.-]/.test(char)) out += char
    else for (const byte of Buffer.from(char)) out += `_${byte.toString(16).padStart(2, '0')}`
  }
  return out
}
