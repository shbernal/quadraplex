import { configuredEcosystems, loadConfig, type Config } from '../core/config.ts'
import { computeDrift, type Drift } from '../core/drift.ts'
import type { IssueDetail } from '../sources/github.ts'
import { skillSlug } from '../sources/skills.ts'
import {
  loadState,
  readCurve,
  readDetail,
  readReleases,
  readSeries,
  readSkills,
} from '../core/store.ts'
import {
  type Ecosystem,
  type Releases,
  type SeriesPoint,
  type Skills,
  type Stargazer,
  type Target,
} from '../core/types.ts'

/** The dashboard's registries pane. All but Docker Hub serve per-day downloads. */
export const REGISTRIES: Ecosystem[] = ['npm', 'pypi', 'ghcr', 'dockerhub', 'rubygems']

/** A score and the number of ratings behind it, from whichever store has the most. */
type Rating = { score: number; count: number; source: Ecosystem }

export type Project = {
  key: string
  name: string
  targets: Target[]
  /** Per-day downloads behind the detail trace, empty when no source serves one. */
  series: SeriesPoint[]
  rating: Rating | null
  drift: Drift
  /** The skills each of its repos publishes, for skills.sh's per-skill installs. */
  skills: Skills[]
}

/**
 * A package and its repo are one project to a human, so rows are built from the `links`
 * field rather than one per artifact. Links are treated as undirected: npm names its
 * repo, the repo does not name the package, and either direction should group them.
 */
function group(targets: Target[]): Target[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const seen = parent.get(id)
    if (seen === undefined || seen === id) return id
    const root = find(seen)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent.set(rb, ra)
  }

  const known = new Set(targets.map((t) => t.id))
  for (const target of targets) {
    parent.set(target.id, parent.get(target.id) ?? target.id)
    for (const link of target.links) if (known.has(link)) union(target.id, link)
  }

  const groups = new Map<string, Target[]>()
  for (const target of targets) {
    const root = find(target.id)
    const list = groups.get(root)
    if (list) list.push(target)
    else groups.set(root, [target])
  }
  return [...groups.values()]
}

/** The best evidenced score wins, because an average over one rating is not a score. */
function rating(targets: Target[]): Rating | null {
  const rated = targets
    .filter((t) => typeof t.metrics.rating === 'number' && typeof t.metrics.ratings === 'number')
    .toSorted((a, b) => (b.metrics.ratings as number) - (a.metrics.ratings as number))
  const best = rated[0]
  if (!best || (best.metrics.ratings as number) === 0) return null
  return {
    score: best.metrics.rating as number,
    count: best.metrics.ratings as number,
    source: best.ecosystem,
  }
}

/** Element-wise sum by date, so a multi-package project gets one honest trace. */
function mergeSeries(all: SeriesPoint[][]): SeriesPoint[] {
  if (all.length <= 1) return all[0] ?? []
  const totals = new Map<string, number>()
  for (const series of all) {
    for (const point of series)
      totals.set(point.date, (totals.get(point.date) ?? 0) + point.downloads)
  }
  return [...totals.entries()]
    .map(([date, downloads]) => ({ date, downloads }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
}

/**
 * Your own scope is noise, someone else's is the only thing telling `@injectlab/cli`
 * apart from every other package called cli, so only the configured account is stripped.
 */
function displayName(targets: Target[], ownScope: string | undefined): string {
  const repo = targets.find((t) => t.ecosystem === 'github')
  if (repo) return repo.name.split('/').at(-1)!
  // A Chrome extension is identified by an opaque 32 letter id, so an unlinked one falls
  // back to the title its listing carries.
  const titled = targets.find((t) => typeof t.metrics.title === 'string')
  if (titled) return titled.metrics.title as string
  return shortName(targets[0]!, ownScope).replace(/^@/, '')
}

/** A package without your own npm scope, an image without the owner every image shares. */
export function shortName(target: Target, ownScope: string | undefined): string {
  const { name } = target
  if (target.ecosystem === 'ghcr' || target.ecosystem === 'dockerhub')
    return name.slice(name.indexOf('/') + 1)
  if (ownScope && name.startsWith(`@${ownScope}/`)) return name.slice(ownScope.length + 2)
  return name
}

/** The skills refresh found in a repo, read only for a repo that reported some. */
function repoSkills(target: Target): Skills | null {
  if (target.ecosystem !== 'github' || target.metrics.skills === undefined) return null
  const reading = readSkills(target.id)
  return reading?.skills.length ? reading : null
}

/**
 * A ClawHub skill names no repo, so it joins the repo publishing a skill of the same slug.
 * A `links` entry in config replaces the match, as it replaces any derived link.
 */
function linkSkills(
  targets: Target[],
  readings: Map<string, Skills>,
  overrides: Config['links'],
): Target[] {
  const repoOf = new Map<string, string>()
  for (const reading of readings.values())
    for (const s of reading.skills) repoOf.set(skillSlug(s.name), reading.id)
  return targets.map((t) => {
    const repo = repoOf.get(t.name)
    if (t.ecosystem !== 'clawhub' || overrides[t.id] || !repo || t.links.includes(repo)) return t
    return { ...t, links: [...t.links, repo] }
  })
}

/**
 * Docker Hub names no source repo, so an image joins the ghcr.io image of the same name,
 * which names one, or else a repo of that name. A `links` entry in config replaces the match.
 */
function linkImages(targets: Target[], overrides: Config['links']): Target[] {
  const byName = new Map<string, string>()
  for (const t of targets) {
    const short = t.name.split('/').at(-1)!
    if (t.ecosystem === 'ghcr' || (t.ecosystem === 'github' && !byName.has(short)))
      byName.set(short, t.id)
  }
  return targets.map((t) => {
    const match = byName.get(t.name.split('/').at(-1)!)
    if (t.ecosystem !== 'dockerhub' || overrides[t.id] || !match || t.links.includes(match))
      return t
    return { ...t, links: [...t.links, match] }
  })
}

export function buildProjects(): Project[] {
  const config = loadConfig()
  const state = loadState(config)
  // An ecosystem whose account was removed keeps its snapshots but leaves the dashboard.
  const shown = configuredEcosystems(config)
  const readings = new Map<string, Skills>()
  for (const t of state.targets) {
    const reading = shown.has(t.ecosystem) ? repoSkills(t) : null
    if (reading) readings.set(t.id, reading)
  }
  const visible = linkImages(
    linkSkills(
      state.targets.filter((t) => shown.has(t.ecosystem)),
      readings,
      config.links,
    ),
    config.links,
  )
  const projects = group(visible).map((targets): Project => {
    const ordered = targets.toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem))
    // Only the registries serve a per-day history, so a repo or a store listing adds
    // nothing to the trace.
    const registries = ordered.filter((t) => REGISTRIES.includes(t.ecosystem))
    return {
      key: ordered.map((t) => t.id).join('+'),
      name: displayName(ordered, config.accounts.npm),
      targets: ordered,
      series: mergeSeries(registries.map((t) => readSeries(t.id))),
      rating: rating(ordered),
      drift: computeDrift(ordered),
      skills: ordered.flatMap((t) => readings.get(t.id) ?? []),
    }
  })
  // Each pane orders its own rows, so this is only the tiebreak they all share.
  return projects.toSorted((a, b) => a.name.localeCompare(b.name))
}

/** The roster, plus the weakest freshness claim it is allowed to make. */
export type Stargazers = { people: Stargazer[]; asOf: string }

/**
 * Who starred, read from the curves `refresh --curves` leaves on disk rather than
 * fetched. A project spanning several repos reports the oldest of their curves, so the
 * age shown is the one the whole roster can stand behind.
 */
export function projectStargazers(project: Project): Stargazers | null {
  const byLogin = new Map<string, Stargazer>()
  let asOf = ''
  for (const target of project.targets) {
    if (target.ecosystem !== 'github') continue
    const curve = readCurve(target.id)
    if (!curve?.stargazers) continue
    if (!asOf || curve.fetchedAt < asOf) asOf = curve.fetchedAt
    for (const person of curve.stargazers) {
      const seen = byLogin.get(person.login)
      if (!seen || person.starredAt > seen.starredAt) byLogin.set(person.login, person)
    }
  }
  if (byLogin.size === 0) return null
  return {
    people: [...byLogin.values()].toSorted((a, b) => b.starredAt.localeCompare(a.starredAt)),
    asOf,
  }
}

/** A repo with stars but no harvested roster is waiting on a curve nobody has built. */
export function awaitingCurves(project: Project): boolean {
  return project.targets.some((target) => {
    const stars = target.metrics.stars
    if (target.ecosystem !== 'github' || typeof stars !== 'number' || stars === 0) return false
    return readCurve(target.id)?.stargazers === undefined
  })
}

/** The release readings refresh leaves beside each repo, for the assets behind the count. */
export function projectReleases(project: Project): Releases[] {
  return project.targets
    .filter(
      (target) => target.ecosystem === 'github' && target.metrics.downloadsTotal !== undefined,
    )
    .map((target) => readReleases(target.id))
    .filter((reading): reading is Releases => reading !== null)
}

/**
 * Open issues and pull requests are written to disk by refresh, so the modal reads them
 * from the store like everything else. The dashboard never fetches.
 */
export function projectItems(project: Project): IssueDetail[] {
  return project.targets
    .filter((target) => target.ecosystem === 'github')
    .flatMap((target) => (readDetail(target.id) as { items?: IssueDetail[] } | null)?.items ?? [])
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** What the detail cursor can land on, in the order the pane draws it. */
export type Focus =
  | { kind: 'target'; url: string; target: Target }
  | { kind: 'item'; url: string; item: IssueDetail }

export function focusables(project: Project, items: IssueDetail[]): Focus[] {
  return [
    ...project.targets.map((target) => ({ kind: 'target' as const, url: target.url, target })),
    ...items.map((item) => ({ kind: 'item' as const, url: item.url, item })),
  ]
}

/**
 * Target ids are searched alongside the display name, so a scope the name has been
 * stripped of, or a Chrome id no human would recognise, is still reachable.
 */
export function matches(project: Project, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    project.name.toLowerCase().includes(q) ||
    project.targets.some((t) => t.id.toLowerCase().includes(q))
  )
}
