import { getJson } from '../core/http.ts'
import { parseTargetId, targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { Gone, githubRepoFromUrl, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://aur.archlinux.org/rpc/v5'
/** Names per `info` call, well inside the URL length the AUR accepts. */
const BATCH = 100

/** The fields a v5 `search` and `info` result share, which are all a snapshot needs. */
type Package = {
  Name: string
  Description: string | null
  Version: string
  NumVotes: number
  Popularity: number
  /** Unix seconds when the package was flagged out of date, null when it is not. */
  OutOfDate: number | null
  /** Unix seconds of the last push to the package's git repo. */
  LastModified: number
  URL: string | null
}

type Reply = { type: string; error?: string; results: Package[] }

/** The RPC answers a bad query with 200 and `type: "error"`, so that is checked here. */
async function rpc(url: string): Promise<Package[]> {
  const { data } = await getJson<Reply>(url)
  if (!data) throw new Error(`no answer from ${url}`)
  if (data.type === 'error') throw new Error(`AUR: ${data.error ?? 'unknown error'}`)
  return data.results
}

const search = (account: string, by: 'maintainer' | 'comaintainers') =>
  rpc(`${API}/search/${encodeURIComponent(account)}?by=${by}`)

async function info(names: string[]): Promise<Package[]> {
  const out: Package[] = []
  for (let i = 0; i < names.length; i += BATCH) {
    const args = names.slice(i, i + BATCH).map((n) => `arg[]=${encodeURIComponent(n)}`)
    out.push(...(await rpc(`${API}/info?${args.join('&')}`)))
  }
  return out
}

/**
 * The two maintainer searches are the roster and carry every field a fetch needs, so the
 * whole account costs two requests. `include` entries they miss share batched `info` calls,
 * and one the AUR does not know is left for its own fetch to answer as gone.
 */
async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.aur
  const found = new Map<string, Descriptor>()
  if (account) {
    const [own, shared] = await Promise.all([
      search(account, 'maintainer'),
      search(account, 'comaintainers'),
    ])
    for (const pkg of [...own, ...shared])
      found.set(pkg.Name, { name: pkg.Name, discovered: 'auto', hint: pkg })
  }
  const included = config.include
    .map(parseTargetId)
    .filter((p) => p?.ecosystem === 'aur' && !found.has(p.name))
    .map((p) => p!.name)
  for (const pkg of await info(included))
    found.set(pkg.Name, { name: pkg.Name, discovered: 'config', hint: pkg })
  return [...found.values()]
}

/** A VCS package builds from the branch head, so its pkgver names a commit, not a release. */
const VCS = /-(git|hg|svn|bzr|darcs|fossil)$/

/** The upstream version, without the epoch or the pkgrel that counts packaging revisions. */
function upstreamVersion(pkg: Package): string | null {
  if (VCS.test(pkg.Name)) return null
  return pkg.Version.replace(/^\d+:/, '').replace(/-[^-]+$/, '')
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/**
 * The AUR counts no downloads. Votes are a lifetime count, and popularity is the AUR's own
 * score of recent votes, decayed daily, so it falls on its own while votes never do.
 */
async function fetchOne(descriptor: Descriptor): Promise<Fetched> {
  let pkg = descriptor.fresh ? undefined : (descriptor.hint as Package | undefined)
  if (!pkg) {
    ;[pkg] = await info([descriptor.name])
    if (!pkg) throw new Gone(`${descriptor.name} is not in the AUR`)
  }
  const repo = githubRepoFromUrl(pkg.URL)
  const snapshot: Snapshot = {
    id: targetId('aur', pkg.Name),
    ecosystem: 'aur',
    name: pkg.Name,
    url: `https://aur.archlinux.org/packages/${encodeURIComponent(pkg.Name)}`,
    discovered: descriptor.discovered,
    metrics: {
      votes: pkg.NumVotes,
      popularity: pkg.Popularity,
      version: upstreamVersion(pkg),
      lastPublish: iso(pkg.LastModified),
      outOfDate: pkg.OutOfDate === null ? 'no' : iso(pkg.OutOfDate),
    },
    links: repo ? [targetId('github', repo)] : [],
    fetchedAt: new Date().toISOString(),
  }
  const fetched: Fetched = { snapshot }
  if (pkg.Description) fetched.detail = { description: pkg.Description }
  return fetched
}

export const aurSource: Source = {
  ecosystem: 'aur',
  roster: true,
  discover,
  fetch: fetchOne,
}
