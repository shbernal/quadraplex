import type { Drift } from '../core/drift.ts'
import { metricLabel, metricText, relativeAge, since, span } from '../core/format.ts'
import { tracks } from '../core/tracks.ts'
import type { Ecosystem, Releases, Skills, Target } from '../core/types.ts'
import type { IssueDetail } from '../sources/github.ts'
import { delta } from './board.ts'
import { box, C, fit, G, paint, seg, type Line } from './cells.ts'
import {
  awaitingCurves,
  focusables,
  projectItems,
  projectReleases,
  projectStargazers,
  type Focus,
  type Project,
  type Stargazers,
} from './model.ts'

/**
 * Everything the detail overlay shows that is not on the board already. It reads the
 * store, so it is built once per opened project rather than once per frame.
 */
export type Inspect = {
  project: Project
  items: IssueDetail[]
  stargazers: Stargazers | null
  waiting: boolean
  releases: Releases[]
  skills: Skills[]
  /** Targets then open items, in the order the overlay draws them: what `o` can open. */
  focus: Focus[]
}

export function inspect(project: Project): Inspect {
  const items = projectItems(project)
  return {
    project,
    items,
    stargazers: projectStargazers(project),
    releases: projectReleases(project),
    skills: project.skills,
    waiting: awaitingCurves(project),
    focus: focusables(project, items),
  }
}

type Body = { line: Line; focus?: number }

const blank: Body = { line: [] }
const heading = (text: string, note?: string): Body => ({
  line: [seg(text, C.accent, { b: true }), ...(note ? [seg(`   ${note}`, C.muted)] : [])],
})

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
/** A quarter of daily counts, averaged into the columns available. */
const WINDOW_DAYS = 90

/** Scaled to its own maximum. A plain number array, so a star curve can reuse it. */
export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return ''
  const tail = values.slice(-WINDOW_DAYS)
  const size = tail.length / width
  const points =
    tail.length <= width
      ? tail
      : Array.from({ length: width }, (_, i) => {
          const slice = tail.slice(
            Math.floor(i * size),
            Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1),
          )
          return slice.reduce((total, value) => total + value, 0) / slice.length
        })
  const max = Math.max(...points)
  if (max <= 0) return BLOCKS[0]!.repeat(points.length)
  const top = BLOCKS.length - 1
  return points.map((v) => BLOCKS[Math.min(top, Math.round((v / max) * top))]!).join('')
}

/**
 * The combined count only earns a line when the split is unknown. Showing both invites
 * the reader to treat one of them as an issue count, which is the mistake to avoid.
 */
function visibleMetrics(metrics: Target['metrics']): [string, Target['metrics'][string]][] {
  const split = metrics.openIssues !== null && metrics.openIssues !== undefined
  return Object.entries(metrics).filter(([key, value]) => {
    if (key === 'openIssuesAndPRs') return !split
    if (key === 'openIssues' || key === 'openPRs') return value !== null
    return true
  })
}

/** Named in words, because a row marker only says that something is off. */
function driftLines(drift: Drift): Body[] {
  const lines: Body[] = []
  if (drift.versions) {
    const versions = drift.versions.map((v) => `${v.ecosystem} ${v.version}`).join('   ')
    lines.push({ line: [seg('≠ ecosystems differ   ', C.warn), seg(versions)] })
    lines.push({
      line: [
        seg('  may be a stale cache, ', C.muted),
        seg('r', C.accent),
        seg(' refreshes this project', C.muted),
      ],
    })
  }
  if (drift.unreleased) {
    const { pushedAt, publishedAt } = drift.unreleased
    lines.push({
      line: [
        seg('⇡ unreleased   ', C.unreleased),
        seg(`pushed ${span(publishedAt, pushedAt)} after the last publish`),
      ],
    })
  }
  if (lines.length) lines.push(blank)
  return lines
}

function icon(ecosystem: Ecosystem): Line {
  const icons: Record<Ecosystem, Line> = {
    github: [seg(G.github, C.github)],
    npm: [seg(G.npm, C.npm)],
    pypi: [seg(G.pypi, C.pypi)],
    ghcr: [seg(G.ghcr, C.ghcr)],
    dockerhub: [seg(G.dockerhub, C.dockerhub)],
    cws: [seg(G.chrome, C.chrome)],
    amo: [seg(G.firefox, C.firefox)],
    clawhub: [seg(G.clawhub, C.clawhub)],
  }
  return icons[ecosystem]
}

function targetLines(target: Target, focus: number): Body[] {
  const lines: Body[] = [
    {
      focus,
      line: [
        ...icon(target.ecosystem),
        seg(` ${target.id}`, C.accent),
        seg(`  ${target.url}`, C.muted),
      ],
    },
    {
      line: [
        seg(`  fetched ${relativeAge(target.fetchedAt)}`, C.muted),
        ...(target.stale ? [seg(`  ${G.hourglass} stale`, C.warn)] : []),
        ...(target.discovered === 'config' ? [seg('  from config', C.muted)] : []),
      ],
    },
  ]
  if (target.errors?.length) {
    lines.push({ line: [seg(`  ✗ ${target.errors.join('; ')}`, C.down)] })
  }
  for (const [key, value] of visibleMetrics(target.metrics)) {
    const d = target.deltas ? (target.deltas[key] ?? null) : null
    lines.push({
      line: [
        seg(`  ${metricLabel(key).padEnd(22)}`),
        seg(metricText(value), C.text, { b: true }),
        ...(typeof value === 'number'
          ? [seg('  '), ...delta(d), seg(since(target.deltaBaselineAt), C.muted)]
          : []),
      ],
    })
  }
  return lines
}

function itemLine(item: IssueDetail, focus: number): Body {
  const pr = item.kind === 'pr'
  const labels = item.labels.length ? `, ${item.labels.join(' ')}` : ''
  return {
    focus,
    line: [
      seg(pr ? G.pr : G.issue, pr ? C.pr : C.issue),
      seg(` #${String(item.number).padEnd(5)}`, C.muted),
      seg(item.title),
      seg(
        `  ${item.author}, ${relativeAge(item.createdAt)}${item.draft ? ', draft' : ''}${labels}`,
        C.muted,
      ),
    ],
  }
}

/** The assets of a release people actually pick between, most downloaded first. */
const ASSETS = 5

/** What each platform's build is pulled for, so the counts on the board have a breakdown. */
function releaseLines(releases: Releases[]): Body[] {
  return releases.flatMap(({ latest, count }) => {
    if (!latest) return []
    const shown = latest.assets.slice(0, ASSETS)
    const more = latest.assets.length - shown.length
    const width = Math.max(...shown.map((a) => a.name.length), 0) + 2
    return [
      blank,
      heading(
        `release ${latest.tag}`,
        `${relativeAge(latest.publishedAt)}, ${count} release${count === 1 ? '' : 's'} on record`,
      ),
      ...shown.map((a) => ({
        line: [seg(`  ${a.name.padEnd(width)}`), seg(String(a.downloads), C.text, { b: true })],
      })),
      ...(more > 0 ? [{ line: [seg(`  and ${more} more assets`, C.muted)] }] : []),
    ]
  })
}

/**
 * Who installs which release line. A package with a single version downloaded has
 * nothing to split, and one never measured shows nothing rather than an empty split.
 */
function trackLines(targets: Target[]): Body[] {
  return targets.flatMap(({ name, versions }) => {
    if (!versions || Object.keys(versions).length < 2) return []
    const split = tracks(versions)
    const total = split.reduce((sum, t) => sum + t.downloads, 0)
    const width = Math.max(...split.map((t) => t.name.length)) + 2
    const count = Math.max(...split.map((t) => String(t.downloads).length))
    return [
      blank,
      heading('release tracks', `${name}, last 7 days`),
      ...split.map(({ name: track, downloads, versions: [top, ...rest] }) => {
        const others = rest.reduce((sum, v) => sum + v.downloads, 0)
        return {
          line: [
            seg(`  ${track.padEnd(width)}`),
            seg(String(downloads).padStart(count), C.text, { b: true }),
            seg(`${String(Math.round((downloads / total) * 100)).padStart(5)}%   `, C.muted),
            seg(`${top!.version} ${top!.downloads}`),
            ...(rest.length
              ? [seg(`, ${rest.length} other${rest.length === 1 ? '' : 's'} ${others}`, C.muted)]
              : []),
          ],
        }
      }),
    ]
  })
}

/** Each skill with its installs, and the command that installs them. */
function skillLines(readings: Skills[]): Body[] {
  return readings.flatMap(({ id, skills }) => {
    const width = Math.max(...skills.map((s) => s.name.length)) + 2
    return [
      blank,
      heading(`${G.skill} skills`, `npx skills add ${id.slice(id.indexOf(':') + 1)}`),
      ...skills.map((s) => ({
        line: [
          seg(`  ${s.name.padEnd(width)}`),
          s.installs === null
            ? seg('not indexed', C.muted, { i: true })
            : seg(`${s.installs} installs`, C.text, { b: true }),
          seg(`  ${s.path}`, C.muted),
        ],
      })),
    ]
  })
}

/** Enough of the roster to see who is arriving, never enough to bury the open items. */
const ROSTER = 5

/**
 * Names, not a leaderboard. A large repo only ever has its tail harvested, so the block
 * says "recent" and never implies the roster adds up to the star count.
 */
function rosterLines(stargazers: Stargazers | null, waiting: boolean): Body[] {
  if (!stargazers) {
    return waiting ? [blank, heading('recent stargazers', 'run "qplex refresh --curves"')] : []
  }
  const shown = stargazers.people.slice(0, ROSTER)
  const more = stargazers.people.length - shown.length
  return [
    blank,
    heading('recent stargazers', `as of ${relativeAge(stargazers.asOf)}`),
    ...shown.map((p) => ({
      line: [seg(`  @${p.login.padEnd(24)}`), seg(`starred ${relativeAge(p.starredAt)}`, C.muted)],
    })),
    ...(more > 0 ? [{ line: [seg(`  and ${more} more on record`, C.muted)] }] : []),
  ]
}

const overlayWidth = (cols: number) => Math.max(20, Math.min(cols - 4, 88))
/** The overlay leaves the screen's header and footer rows showing. */
const overlayRows = (rows: number) => Math.max(1, rows - 4)

/**
 * One scrolling flow, windowed around the cursor. Budgeting only the open items would
 * let a project spanning several ecosystems push its own title off a short terminal.
 */
export function detailBox(d: Inspect, cursor: number, cols: number, rows: number): Line[] {
  const w = overlayWidth(cols)
  const inner = w - 4
  const body: Body[] = driftLines(d.project.drift)
  d.project.targets.forEach((t, i) => {
    if (i) body.push(blank)
    body.push(...targetLines(t, i))
  })
  const values = d.project.series.map((p) => p.downloads)
  if (values.length) {
    body.push(blank, heading('downloads', `last ${Math.min(values.length, WINDOW_DAYS)} days`))
    body.push({ line: [seg('  '), seg(sparkline(values, inner - 3), C.up)] })
  }
  body.push(...trackLines(d.project.targets))
  body.push(...releaseLines(d.releases))
  body.push(...skillLines(d.skills))
  if (d.items.length) {
    body.push(blank, heading('open items'))
    d.items.forEach((item, i) => body.push(itemLine(item, d.project.targets.length + i)))
  }
  body.push(...rosterLines(d.stargazers, d.waiting))

  const height = Math.min(body.length, overlayRows(rows))
  const at = body.findIndex((b) => b.focus === cursor)
  const start = Math.max(
    0,
    Math.min(at < 0 ? 0 : at - Math.floor(height / 2), body.length - height),
  )
  const below = body.length - start - height
  const lines = body.slice(start, start + height).map(({ line, focus }) => {
    const on = focus !== undefined && focus === cursor
    return paint(fit([seg(on ? '▌' : ' ', C.accent), ...line], inner), on ? C.cursor : undefined)
  })
  const position: Line = [
    seg(
      [start ? `↑${start}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' '),
      C.muted,
    ),
  ]
  const keys: Line = [
    seg('jk', C.accent),
    seg(' move  '),
    ...(d.items.length ? [seg('⏎', C.accent), seg(' read  ')] : []),
    seg('o', C.accent),
    seg(' open  '),
    seg('r', C.accent),
    seg(' refresh  '),
    seg('esc', C.accent),
    seg(' close'),
  ]
  return box([seg(` ${d.project.name} `, C.ink, { bg: C.accent, b: true })], lines, w, [
    position,
    keys,
  ])
}

function wrapText(body: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of body.replaceAll('\r', '').split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph)
      continue
    }
    let current = ''
    for (const word of paragraph.split(' ')) {
      if (current.length + word.length + 1 > width) {
        lines.push(current)
        current = word
      } else current = current ? `${current} ${word}` : word
    }
    lines.push(current)
  }
  return lines
}

/** Title, byline, url and a gap sit above the scrolling body. */
const ITEM_HEAD = 4

const itemText = (item: IssueDetail, cols: number) =>
  wrapText(item.body || '(no description)', overlayWidth(cols) - 4)

/** How far the body can scroll before its last line reaches the bottom of the overlay. */
export function itemScrollMax(item: IssueDetail, cols: number, rows: number): number {
  return Math.max(0, itemText(item, cols).length - (overlayRows(rows) - ITEM_HEAD))
}

/** The full body in place, because bouncing to a browser to read one issue is the thing a
 * dashboard is supposed to save you. */
export function itemBox(item: IssueDetail, offset: number, cols: number, rows: number): Line[] {
  const text = itemText(item, cols)
  const room = Math.max(0, overlayRows(rows) - ITEM_HEAD)
  const from = Math.max(0, Math.min(offset, text.length - room))
  const shown = text.slice(from, from + room)
  const more = text.length - from - shown.length
  const labels = item.labels.length ? `, ${item.labels.join(' ')}` : ''
  const body: Line[] = [
    [seg(item.title, C.text, { b: true })],
    [
      seg(
        `${item.author}, opened ${relativeAge(item.createdAt)}, ${item.comments} comments${item.draft ? ', draft' : ''}${labels}`,
        C.muted,
      ),
    ],
    [seg(item.url, C.muted)],
    [],
    ...shown.map((t) => [seg(t)]),
  ].slice(0, overlayRows(rows))
  const pr = item.kind === 'pr'
  return box(
    [seg(` ${pr ? 'PR' : 'issue'} #${item.number} `, C.ink, { bg: pr ? C.pr : C.issue, b: true })],
    body,
    overlayWidth(cols),
    [
      [seg(more > 0 ? `↓${more}` : '', C.muted)],
      [
        seg('jk', C.accent),
        seg(' scroll  '),
        seg('o', C.accent),
        seg(' open  '),
        seg('esc', C.accent),
        seg(' back'),
      ],
    ],
  )
}
