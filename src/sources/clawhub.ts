import { getJson, postText } from '../core/http.ts'
import { targetId, type Snapshot } from '../core/types.ts'
import type { Config } from '../core/config.ts'
import { orGone, type Descriptor, type Fetched, type Source } from './types.ts'

const API = 'https://clawhub.ai/api/v1'
/**
 * The public API has no per-publisher listing. The publisher page reads its roster from
 * this Convex deployment, whose queries are public by design, so discovery asks the same
 * query the page does.
 */
const CONVEX = 'https://wry-manatee-359.convex.cloud/api/query'
/** The query clamps a page to 24 items. */
const PAGE = 24

type Published = { slug: string; kind: string }

type Answer = {
  status: 'success' | 'error'
  errorMessage?: string
  value?: { page: Published[]; continueCursor: string; isDone: boolean }
}

type Detail = {
  skill: {
    slug: string
    displayName: string | null
    stats: { downloads?: number; installs?: number; stars?: number }
  }
  latestVersion: { version: string; createdAt: number } | null
  owner: { handle: string } | null
}

async function discover(config: Config): Promise<Descriptor[]> {
  const account = config.accounts.clawhub
  if (!account) return []
  const out: Descriptor[] = []
  let cursor: string | null = null
  for (;;) {
    const body = JSON.stringify({
      path: 'publishers:listPublishedPage',
      args: { handle: account, kind: 'skill', paginationOpts: { numItems: PAGE, cursor } },
      format: 'json',
    })
    const { data } = await postText(CONVEX, body, 'application/json', {
      accept: 'application/json',
    })
    const answer = JSON.parse(data ?? '{}') as Answer
    if (answer.status !== 'success' || !answer.value) {
      throw new Error(`ClawHub publisher query failed: ${answer.errorMessage ?? 'no answer'}`)
    }
    for (const item of answer.value.page) {
      if (item.kind === 'skill') out.push({ name: item.slug, discovered: 'auto' })
    }
    if (answer.value.isDone || !answer.value.continueCursor) break
    cursor = answer.value.continueCursor
  }
  return out
}

/**
 * Slugs are unique per publisher, not globally, so the account qualifies the lookup and a
 * skill handed to someone else answers 404. `installs` is ClawHub's all-time count of users
 * whose CLI reported one, the same unit as skills.sh, and ClawHub discards skills.sh events,
 * so the two never count the same install.
 */
async function fetchOne(descriptor: Descriptor, config: Config): Promise<Fetched> {
  const owner = config.accounts.clawhub
  const query = owner ? `?ownerHandle=${encodeURIComponent(owner)}` : ''
  const url = `${API}/skills/${encodeURIComponent(descriptor.name)}${query}`
  const { data } = await orGone(getJson<Detail>(url))
  if (!data?.skill) throw new Error(`no skill data for ${descriptor.name}`)
  const { skill, latestVersion } = data
  const handle = data.owner?.handle ?? owner
  const snapshot: Snapshot = {
    id: targetId('clawhub', skill.slug),
    ecosystem: 'clawhub',
    name: skill.slug,
    url: handle
      ? `https://clawhub.ai/${handle}/skills/${skill.slug}`
      : `https://clawhub.ai/skills/${skill.slug}`,
    discovered: descriptor.discovered,
    metrics: {
      installs: skill.stats.installs ?? null,
      downloads: skill.stats.downloads ?? null,
      stars: skill.stats.stars ?? null,
      version: latestVersion?.version ?? null,
      lastPublish: latestVersion ? new Date(latestVersion.createdAt).toISOString() : null,
      title: skill.displayName ?? null,
    },
    links: [],
    fetchedAt: new Date().toISOString(),
  }
  return { snapshot }
}

export const clawhubSource: Source = {
  ecosystem: 'clawhub',
  roster: true,
  discover,
  fetch: fetchOne,
}
