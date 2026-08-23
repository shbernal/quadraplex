import { configured, loadConfig } from '../core/config.ts'
import { loadState } from '../core/store.ts'
import { formatDelta, relativeAge, since, table } from '../core/format.ts'
import {
  ECOSYSTEMS,
  HEADLINE_METRIC,
  SCHEMA_VERSION,
  type Ecosystem,
  type Target,
} from '../core/types.ts'

type StatusEntry = {
  id: string
  ecosystem: Ecosystem
  name: string
  discovered: 'auto' | 'config'
  headline: { metric: string; value: number | string | null }
  delta: number | null
  deltaBaselineAt?: string
  changed: boolean
  stale: boolean
  fetchedAt: string
  errors?: string[]
}

export type StatusPayload = {
  schemaVersion: number
  generatedAt: string
  discovery: Record<Ecosystem, 'auto' | 'config' | 'empty'>
  hints: string[]
  targets: StatusEntry[]
}

function entry(target: Target): StatusEntry {
  const metric = HEADLINE_METRIC[target.ecosystem]
  const delta = target.deltas ? (target.deltas[metric] ?? null) : null
  const out: StatusEntry = {
    id: target.id,
    ecosystem: target.ecosystem,
    name: target.name,
    discovered: target.discovered,
    headline: { metric, value: target.metrics[metric] ?? null },
    delta,
    changed: target.deltas
      ? Object.values(target.deltas).some((d) => d !== null && d !== 0)
      : false,
    stale: target.stale,
    fetchedAt: target.fetchedAt,
  }
  if (target.deltaBaselineAt) out.deltaBaselineAt = target.deltaBaselineAt
  if (target.errors?.length) out.errors = target.errors
  return out
}

export function statusPayload(): StatusPayload {
  const config = loadConfig()
  const state = loadState(config)
  const targets = state.targets

  const discovery = {} as Record<Ecosystem, 'auto' | 'config' | 'empty'>
  const hints: string[] = []
  for (const ecosystem of ECOSYSTEMS) {
    const owned = targets.filter((t) => t.ecosystem === ecosystem)
    discovery[ecosystem] =
      owned.length === 0
        ? 'empty'
        : owned.every((t) => t.discovered === 'config')
          ? 'config'
          : 'auto'
  }
  if (!configured()) {
    hints.push('No accounts are set up. Run "qplex init" to choose them.')
  } else {
    hints.push(...ecosystemHints(discovery))
    if (targets.length === 0) hints.push('The store is empty. Run "qplex refresh" to populate it.')
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: state.generatedAt,
    discovery,
    hints,
    targets: targets.map(entry),
  }
}

function ecosystemHints(discovery: Record<Ecosystem, 'auto' | 'config' | 'empty'>): string[] {
  const hints: string[] = []
  if (discovery.pypi === 'empty') {
    hints.push(
      'PyPI discovery keys on the account name. Set "accounts": {"pypi": "<user>"} in config.json.',
    )
  }
  if (discovery.cws === 'empty') {
    hints.push(
      'Chrome Web Store discovery searches for the listing\'s "Offered by" name. Set "accounts": {"cws": "<name>"} in config.json, and add "include": ["cws:<32 letter id>"] for an unlisted extension.',
    )
  }
  if (discovery.amo === 'empty') {
    hints.push(
      'AMO discovery keys on the author\'s numeric user id. Set "accounts": {"amo": "<id>"} in config.json.',
    )
  }
  return hints
}

export function statusTable(payload: StatusPayload): string {
  if (payload.targets.length === 0) return payload.hints.join('\n')

  const rows: string[][] = [['', 'TARGET', 'METRIC', 'VALUE', 'DELTA', 'AGE']]
  for (const t of payload.targets) {
    rows.push([
      t.changed ? '*' : t.stale ? '!' : ' ',
      t.id,
      t.headline.metric,
      t.headline.value === null ? '-' : String(t.headline.value),
      // A headline the source publishes as text cannot be subtracted, so it gets no
      // delta rather than a permanent "new".
      typeof t.headline.value === 'number' ? formatDelta(t.delta) + since(t.deltaBaselineAt) : '',
      relativeAge(t.fetchedAt),
    ])
  }

  const legend = [
    '',
    '* changed   ! stale   delta "new" means no baseline yet, not zero',
    ...ECOSYSTEMS.map((e) => `${e} list: ${payload.discovery[e]}`),
  ].join('\n')

  return `${table(rows, ['left', 'left', 'left', 'right', 'right', 'right'])}\n${legend}${
    payload.hints.length ? `\n\n${payload.hints.join('\n')}` : ''
  }`
}
