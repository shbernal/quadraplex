import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from '../core/args.ts'
import { DEFAULT_CONFIG, saveAccounts } from '../core/config.ts'
import { describe } from '../core/errors.ts'
import { paths } from '../core/paths.ts'
import { table } from '../core/format.ts'
import { HttpError } from '../core/http.ts'
import { ECOSYSTEMS, SCHEMA_VERSION, type Ecosystem } from '../core/types.ts'
import { findAccount } from '../sources/amo.ts'
import { publicRepos } from '../sources/github.ts'
import { sourceFor } from '../sources/all.ts'
import { PartialDiscovery } from '../sources/types.ts'
import { parseOnly } from './refresh.ts'

type Origin = 'gh' | 'git' | 'handle' | 'typed'

export type Suggestion = {
  ecosystem: Ecosystem
  value: string | null
  source: Origin | null
  status: 'found' | 'none' | 'unchecked'
  count?: number
  /** A name to show beside an opaque value, such as an AMO user id. */
  label?: string
  reason?: string
}

export type SuggestPayload = { schemaVersion: number; suggestions: Suggestion[] }

/** gh keeps its login in `hosts.yml`, under the host it was authenticated against. */
function ghUser(): string | null {
  const dir =
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh')
  let yaml: string
  try {
    yaml = readFileSync(join(dir, 'hosts.yml'), 'utf8')
  } catch {
    return null
  }
  const block = /^github\.com:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(yaml)?.[1] ?? ''
  return /^[ \t]+user:[ \t]*["']?([^\s"']+)/m.exec(block)?.[1] ?? null
}

/** `github.user` is a login. `user.name` is a display name and is never read. */
function gitUser(): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'github.user'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function seed(handle: unknown): { value: string; source: Origin } | null {
  if (typeof handle === 'string' && handle) return { value: handle, source: 'handle' }
  const gh = ghUser()
  if (gh) return { value: gh, source: 'gh' }
  const git = gitUser()
  return git ? { value: git, source: 'git' } : null
}

type Found = { count: number; value?: string; label?: string }

/** What discovery would find for this account, so the count matches the first refresh. */
async function discovered(ecosystem: Ecosystem, account: string): Promise<Found> {
  const config = { ...structuredClone(DEFAULT_CONFIG), accounts: { [ecosystem]: account } }
  try {
    return { count: (await sourceFor(ecosystem).discover(config)).length }
  } catch (error) {
    if (error instanceof PartialDiscovery) return { count: error.found.length }
    throw error
  }
}

const PROBES: Record<Ecosystem, (account: string) => Promise<Found>> = {
  npm: (account) => discovered('npm', account),
  pypi: (account) => discovered('pypi', account),
  cws: (account) => discovered('cws', account),
  clawhub: (account) => discovered('clawhub', account),
  ghcr: (account) => discovered('ghcr', account),
  dockerhub: (account) => discovered('dockerhub', account),
  rubygems: (account) => discovered('rubygems', account),
  jsr: (account) => discovered('jsr', account),
  vscode: (account) => discovered('vscode', account),
  openvsx: (account) => discovered('openvsx', account),
  aur: (account) => discovered('aur', account),
  packagist: (account) => discovered('packagist', account),
  nuget: (account) => discovered('nuget', account),
  github: async (account) => ({ count: await publicRepos(account) }),
  amo: async (account) => {
    const found = await findAccount(account)
    if (!found) return { count: 0 }
    const label = found.byDisplayName ? `${found.name}, by display name` : found.name
    return { count: found.num_addons_listed, value: String(found.id), label }
  },
}

async function probe(ecosystem: Ecosystem, value: string, source: Origin): Promise<Suggestion> {
  try {
    const found = await PROBES[ecosystem](value)
    const out: Suggestion = {
      ecosystem,
      value: found.value ?? value,
      source,
      status: found.count > 0 ? 'found' : 'none',
      count: found.count,
    }
    if (found.label) out.label = found.label
    return out
  } catch (error) {
    // A 404 is the ecosystem saying there is no such account, which is an answer.
    if (error instanceof HttpError && error.status === 404) {
      return { ecosystem, value, source, status: 'none', count: 0 }
    }
    return { ecosystem, value, source, status: 'unchecked', reason: describe(error) }
  }
}

/**
 * Seeds one handle from local sources, or takes typed values per ecosystem, and asks each
 * ecosystem what it holds for it. Never throws on the network: a probe that cannot reach
 * its ecosystem comes back unchecked with the reason.
 */
export async function suggest(flags: Record<string, string | boolean>): Promise<SuggestPayload> {
  const ecosystems = flags.only === undefined ? ECOSYSTEMS : parseOnly(flags.only)
  const seeded = seed(flags.handle)
  const suggestions = await Promise.all(
    ecosystems.map((ecosystem): Promise<Suggestion> => {
      const typed = flags[ecosystem]
      if (typed === true || typed === '') throw new UsageError(`--${ecosystem} needs a value`)
      if (typeof typed === 'string') return probe(ecosystem, typed, 'typed')
      if (seeded) return probe(ecosystem, seeded.value, seeded.source)
      return Promise.resolve({ ecosystem, value: null, source: null, status: 'none' })
    }),
  )
  return { schemaVersion: SCHEMA_VERSION, suggestions }
}

const NOUN: Record<Ecosystem, string> = {
  npm: 'package',
  pypi: 'package',
  github: 'repo',
  ghcr: 'image',
  amo: 'add-on',
  cws: 'extension',
  clawhub: 'skill',
  dockerhub: 'image',
  rubygems: 'gem',
  jsr: 'package',
  vscode: 'extension',
  openvsx: 'extension',
  aur: 'package',
  packagist: 'package',
  nuget: 'package',
}

/** What a probe found, in the words a suggestion row shows. */
export function foundText(s: Suggestion): string {
  if (s.status === 'unchecked') return `couldn't check: ${s.reason}`
  if (s.status === 'none' || !s.count) return 'nothing found'
  return `${s.count} ${NOUN[s.ecosystem]}${s.count === 1 ? '' : 's'}`
}

export function suggestTable(payload: SuggestPayload): string {
  return table([
    ['ECOSYSTEM', 'ACCOUNT', 'FROM', 'FOUND'],
    ...payload.suggestions.map((s) => [
      s.ecosystem,
      s.label ? `${s.value} (${s.label})` : (s.value ?? '-'),
      s.source ?? '-',
      foundText(s),
    ]),
  ])
}

export const INIT_USAGE = `qplex init --suggest               find accounts and probe each ecosystem
qplex init --<ecosystem> <account>  set an account, or remove it with ''`

/** The accounts named on the command line, or null when none was. */
export function accountFlags(
  flags: Record<string, string | boolean>,
): Partial<Record<Ecosystem, string>> | null {
  const out: Partial<Record<Ecosystem, string>> = {}
  for (const ecosystem of ECOSYSTEMS) {
    const value = flags[ecosystem]
    if (typeof value === 'string') out[ecosystem] = value.trim()
  }
  return Object.keys(out).length ? out : null
}

export type InitPayload = {
  schemaVersion: number
  config: string
  accounts: Partial<Record<Ecosystem, string>>
}

export function writeAccounts(changes: Partial<Record<Ecosystem, string>>): InitPayload {
  const { accounts } = saveAccounts(changes)
  return { schemaVersion: SCHEMA_VERSION, config: paths.config, accounts }
}

export function initText(payload: InitPayload): string {
  const rows = ECOSYSTEMS.filter((e) => payload.accounts[e]).map((e) => [e, payload.accounts[e]!])
  const body = rows.length ? table(rows) : 'no accounts set'
  return `${body}\n\nsaved to ${payload.config}`
}
