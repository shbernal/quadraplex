import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Everything the tool owns lives under one directory. config.json sits with the data
 * on purpose: it names the accounts the store was built from, so a store without its
 * config is not reproducible.
 */
export function dataDir(): string {
  const override = process.env.QUADRAPLEX_DATA_DIR
  if (override) return override
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'share'), 'quadraplex')
}

export const paths = {
  get root() {
    return dataDir()
  },
  get snapshots() {
    return join(dataDir(), 'snapshots.jsonl')
  },
  get state() {
    return join(dataDir(), 'state.json')
  },
  get config() {
    return join(dataDir(), 'config.json')
  },
  get cache() {
    return join(dataDir(), 'cache.json')
  },
  curve(id: string) {
    return join(dataDir(), 'curves', `${slug(id)}.json`)
  },
  series(id: string) {
    return join(dataDir(), 'series', `${slug(id)}.json`)
  },
}

export function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}
