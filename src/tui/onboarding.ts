import type { Suggestion } from '../commands/init.ts'
import { foundText } from '../commands/init.ts'
import type { Ecosystem } from '../core/types.ts'
import { box, C, fit, G, join, seg, width, type Line } from './cells.ts'

/**
 * The accounts screen, as a pure frame like the dashboard's. Five rows, one per
 * ecosystem: a checkbox, the account, and where the account came from or what its
 * ecosystem holds for it. Probes and the first refresh run in a child CLI, never here.
 */

export type AccountRow = {
  ecosystem: Ecosystem
  checked: boolean
  value: string
  /** `config` is an account already saved, the rest are where a suggestion came from. */
  origin: Suggestion['source'] | 'config'
  status: Suggestion['status'] | 'probing' | 'idle'
  count?: number
  label?: string
  reason?: string
  /** The handle a probe tried and found nothing for, kept to say so. */
  tried?: string
}

export type Progress = { ecosystem: Ecosystem; state: 'running' | 'done' }

export type OnboardingView = {
  rows: AccountRow[]
  /** Rows first, then the save line. */
  cursor: number
  /** The text of the field being edited, or null. */
  editing: string | null
  /** Set once saved: the first refresh, every source at once. */
  progress: Progress[] | null
  notice: string | null
  /** Advances the spinners. */
  tick: number
  /** Opened over an existing config rather than on a first launch. */
  reconfigure: boolean
}

export const ROW_ORDER: Ecosystem[] = [
  'github',
  'ghcr',
  'dockerhub',
  'npm',
  'pypi',
  'rubygems',
  'amo',
  'cws',
  'clawhub',
  'jsr',
]

type Meta = { label: string; icon: string; color: string | undefined; help: string }

/** Built per call, because the glyph table is chosen at startup. */
const meta = (e: Ecosystem): Meta =>
  ({
    github: {
      label: 'GitHub',
      icon: G.github,
      color: C.github,
      help: 'Your GitHub login. Public repos only, no token needed.',
    },
    ghcr: {
      label: 'ghcr.io',
      icon: G.ghcr,
      color: C.ghcr,
      help: 'The GitHub login owning your images on ghcr.io.',
    },
    dockerhub: {
      label: 'Docker Hub',
      icon: G.dockerhub,
      color: C.dockerhub,
      help: 'Your Docker Hub username, the namespace your images live under.',
    },
    npm: { label: 'npm', icon: G.npm, color: C.npm, help: 'Your npm username.' },
    jsr: {
      label: 'JSR',
      icon: G.jsr,
      color: C.jsr,
      help: 'Your JSR scope, without the @. JSR cannot look a user up by login.',
    },
    pypi: { label: 'PyPI', icon: G.pypi, color: C.pypi, help: 'Your PyPI username.' },
    rubygems: {
      label: 'RubyGems',
      icon: G.rubygems,
      color: C.rubygems,
      help: 'Your RubyGems handle, the owner your gems list.',
    },
    amo: {
      label: 'Firefox add-ons',
      icon: G.firefox,
      color: C.firefox,
      help: 'Your AMO display name, or the user id ending your profile URL.',
    },
    cws: {
      label: 'Chrome Web Store',
      icon: G.chrome,
      color: C.chrome,
      help: 'The publisher name your listings show as "Offered by".',
    },
    clawhub: {
      label: 'ClawHub',
      icon: G.clawhub,
      color: C.clawhub,
      help: 'Your ClawHub publisher handle, the GitHub login you signed in with.',
    },
  })[e]

const spinner = (tick: number) => {
  const frames = Array.from(G.spin)
  return frames[tick % frames.length]!
}

const ORIGIN: Record<string, string> = { gh: 'gh', git: 'git', config: 'saved' }

function result(row: AccountRow, tick: number, labelled: boolean): Line {
  if (row.status === 'probing') return [seg(`${spinner(tick)} checking`, C.muted)]
  if (row.status === 'idle') return []
  if (row.status === 'unchecked') {
    return [seg(`couldn't check: ${row.reason ?? 'unknown'}`, C.warn)]
  }
  if (row.status === 'none') {
    return [seg(row.tried ? `nothing found for ${row.tried}` : 'nothing found', C.muted)]
  }
  const found = foundText({ ...row, value: row.value, source: null, status: 'found' })
  const origin = row.origin ? ORIGIN[row.origin] : undefined
  return [
    ...(origin ? [seg(`${origin} · `, C.muted)] : []),
    ...(labelled && row.label ? [seg(`${row.label} · `, C.text)] : []),
    seg(found, C.up),
  ]
}

function accountLine(row: AccountRow, view: OnboardingView, i: number, inner: number): Line {
  const m = meta(row.ecosystem)
  const here = view.cursor === i && !view.progress
  const editing = here && view.editing !== null
  const field: Line = editing
    ? [seg(view.editing!, C.text), seg('▏', C.accent)]
    : row.value
      ? [seg(row.value, row.checked ? C.text : C.muted, { b: here })]
      : [seg('-', C.muted)]
  const lead: Line = [
    seg(here ? '▌' : ' ', C.accent),
    seg(row.checked ? '[x] ' : '[ ] ', row.checked ? C.up : C.muted),
    seg(`${m.icon} `, m.color),
    ...fit([seg(m.label, here ? C.text : undefined, { b: here })], 17),
    // The account gives way before what was found for it does.
    ...fit(field, Math.max(10, Math.min(24, inner - 55))),
    seg(' '),
  ]
  // A label gives way before the count it sits beside.
  const line = [...lead, ...result(row, view.tick, true)]
  return fit(width(line) > inner ? [...lead, ...result(row, view.tick, false)] : line, inner)
}

function progressLine(p: Progress, tick: number): Line {
  const m = meta(p.ecosystem)
  const mark = p.state === 'done' ? seg('✓', C.up) : seg(spinner(tick), C.accent)
  const state = p.state === 'done' ? 'done' : 'refreshing'
  return [
    seg(' '),
    mark,
    seg(' '),
    seg(`${m.icon} `, m.color),
    ...fit([seg(m.label)], 18),
    seg(state, C.muted),
  ]
}

function body(view: OnboardingView, inner: number): Line[] {
  if (view.progress) {
    return [
      [seg('Saved. Running the first refresh.', C.text)],
      [],
      ...view.progress.map((p) => progressLine(p, view.tick)),
    ]
  }
  const intro = view.reconfigure
    ? 'The accounts quadraplex follows. Unchecked rows are removed.'
    : 'Which accounts do you publish from? Checked rows are saved.'
  const save = view.cursor === view.rows.length
  const current = view.rows[view.cursor]
  const help = current
    ? meta(current.ecosystem).help
    : 'Writes the config, then runs the first refresh.'
  const lines: Line[] = [
    [seg(intro, C.text)],
    [],
    ...view.rows.map((row, i) => accountLine(row, view, i, inner)),
    [],
    [seg(`  ${help}`, C.muted, { i: true })],
    [],
    [
      seg(save ? '▌' : ' ', C.accent),
      seg(` ${save ? '▶' : ' '} Save and refresh `, save ? C.ink : C.accent, {
        b: true,
        bg: save ? C.accent : undefined,
      }),
    ],
  ]
  if (view.notice) lines.push([], [seg(`✗ ${view.notice}`, C.down, { b: true })])
  return lines
}

function footer(view: OnboardingView, cols: number): Line {
  const keys: [string, string][] = view.progress
    ? [['q', 'quit, the rest refreshes later']]
    : view.editing !== null
      ? [
          ['⏎', 'check it'],
          ['esc', 'cancel'],
        ]
      : [
          ['jk', 'row'],
          ['space', 'check'],
          ['⏎', 'edit or save'],
          ['esc', view.reconfigure ? 'back' : 'quit'],
        ]
  const chips = keys.map(([k, label]) => [seg(k, C.accent, { b: true }), seg(` ${label}`, C.muted)])
  return fit([seg(' '), ...join(chips, [seg('  ·  ', C.muted)])], cols)
}

export function onboardingFrame(view: OnboardingView, cols: number, rows: number): Line[] {
  const brand: Line = [seg(' QUADRAPLEX ', C.ink, { bg: C.accent, b: true })]
  const title = view.reconfigure ? 'accounts' : 'first run'
  const head = fit([...brand, seg(`  ${title}`, C.muted)], cols)
  const w = Math.min(cols, 100)
  const inner = w - 4
  const card = box([seg(`${G.users} ACCOUNTS`, C.accent, { b: true })], body(view, inner), w, [])
  const space = rows - 2
  const shown = card.slice(0, space)
  const top = Math.max(0, Math.floor((space - shown.length) / 2))
  const left = Math.max(0, Math.floor((cols - w) / 2))
  const out: Line[] = [head]
  for (let i = 0; i < space; i++) {
    const line = shown[i - top]
    out.push(line ? fit([seg(' '.repeat(left)), ...line], cols) : fit([], cols))
  }
  out.push(footer(view, cols))
  return out.map((l) => (width(l) === cols ? l : fit(l, cols)))
}
