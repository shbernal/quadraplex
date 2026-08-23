import { useApp, useInput, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { Suggestion } from '../commands/init.ts'
import { configured, configuredEcosystems, loadConfig, saveAccounts } from '../core/config.ts'
import type { Ecosystem, Target } from '../core/types.ts'
import { App } from './app.tsx'
import { Lines } from './lines.tsx'
import {
  onboardingFrame,
  ROW_ORDER,
  type AccountRow,
  type OnboardingView,
  type Progress,
} from './onboarding.ts'
import { probe, refresh, refreshTargets, type RefreshOutcome } from './spawn.ts'

type Probe = (flags: Record<string, string>) => Promise<Suggestion[]>
type Refresh = (only: Ecosystem | null) => Promise<RefreshOutcome>

/** A probe's answer folded into its row. A miss keeps the row empty and says what was tried. */
function settle(row: AccountRow, s: Suggestion, typed: boolean): AccountRow {
  const base = { ecosystem: row.ecosystem, origin: row.origin, status: s.status }
  const extra = { count: s.count, label: s.label, reason: s.reason }
  if (typed || row.origin === 'config') {
    return { ...base, ...extra, checked: row.checked, value: s.value ?? row.value }
  }
  if (s.status === 'found') {
    return { ...base, ...extra, origin: s.source, checked: true, value: s.value ?? '' }
  }
  // Nothing to try is not the same as nothing found, so such a row stays blank.
  if (s.value === null) return { ...base, origin: null, checked: false, value: '', status: 'idle' }
  if (s.status === 'none') {
    return { ...base, origin: s.source, checked: false, value: '', tried: s.value ?? undefined }
  }
  return { ...base, ...extra, origin: s.source, checked: false, value: s.value ?? '' }
}

function initialRows(): AccountRow[] {
  const accounts = configured() ? loadConfig().accounts : {}
  return ROW_ORDER.map((ecosystem) => {
    const value = accounts[ecosystem]
    return value
      ? { ecosystem, checked: true, value, origin: 'config', status: 'probing' }
      : { ecosystem, checked: false, value: '', origin: null, status: 'probing' }
  })
}

/**
 * Seeds the rows, probes them all once, re-probes a row whose value was edited, and on
 * save writes the config and runs the first refresh before handing over. Nothing is
 * written until save: quitting earlier leaves the install as it was.
 */
function Onboarding({
  reconfigure,
  onProbe,
  onRefresh,
  onSaved,
  onCancel,
}: {
  reconfigure: boolean
  onProbe: Probe
  onRefresh: Refresh
  onSaved: (notice: string | null) => void
  onCancel: () => void
}) {
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  const [accounts, setAccounts] = useState(initialRows)
  const [cursor, setCursor] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  /** The latest probe per row, so an answer to an edit since replaced is dropped. */
  const asked = useRef<Partial<Record<Ecosystem, number>>>({})

  const busy =
    progress?.some((p) => p.state !== 'done') || accounts.some((r) => r.status === 'probing')
  useEffect(() => {
    if (!busy) return undefined
    const timer = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(timer)
  }, [busy])

  const update = (ecosystem: Ecosystem, change: (row: AccountRow) => AccountRow) =>
    setAccounts((all) => all.map((r) => (r.ecosystem === ecosystem ? change(r) : r)))

  const run = (flags: Record<string, string>, only: Ecosystem[], typed: boolean) => {
    const ids = Object.fromEntries(
      only.map((e) => [e, (asked.current[e] = (asked.current[e] ?? 0) + 1)]),
    )
    const current = (e: Ecosystem) => asked.current[e] === ids[e]
    onProbe(flags).then(
      (found) => {
        for (const s of found) {
          if (current(s.ecosystem)) update(s.ecosystem, (r) => settle(r, s, typed))
        }
      },
      (error: Error) => {
        for (const e of only) {
          if (!current(e)) continue
          update(e, (r) => ({ ...r, status: 'unchecked', reason: error.message }))
        }
      },
    )
  }

  // One probe for every row on open. Saved accounts are probed as typed, so a
  // reconfigure shows what each one holds rather than what the seed handle would.
  useEffect(() => {
    const flags: Record<string, string> = {}
    for (const r of accounts) if (r.origin === 'config') flags[r.ecosystem] = r.value
    run(flags, ROW_ORDER, false)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, [])

  const commit = (row: AccountRow, text: string) => {
    const value = text.trim()
    setEditing(null)
    if (value === row.value && row.status !== 'idle') return
    if (!value) {
      asked.current[row.ecosystem] = (asked.current[row.ecosystem] ?? 0) + 1
      update(row.ecosystem, (r) => ({
        ecosystem: r.ecosystem,
        checked: false,
        value: '',
        origin: null,
        status: 'idle',
      }))
      return
    }
    update(row.ecosystem, (r) => ({
      ...r,
      value,
      checked: true,
      origin: 'typed',
      status: 'probing',
    }))
    run({ only: row.ecosystem, [row.ecosystem]: value }, [row.ecosystem], true)
  }

  const save = async () => {
    const changes: Partial<Record<Ecosystem, string>> = {}
    for (const r of accounts) changes[r.ecosystem] = r.checked && r.value ? r.value : ''
    const include = configured() ? loadConfig().include : []
    if (!Object.values(changes).some(Boolean) && !include.length) {
      setNotice('check at least one account')
      return
    }
    let saved
    try {
      saved = saveAccounts(changes)
    } catch (error) {
      setNotice((error as Error).message)
      return
    }
    const order = ROW_ORDER.filter((e) => configuredEcosystems(saved).has(e))
    setProgress(order.map((ecosystem) => ({ ecosystem, state: 'running' })))
    const outcomes = await Promise.all(
      order.map(async (only) => {
        const outcome = await onRefresh(only)
        setProgress((p) => p && p.map((x) => (x.ecosystem === only ? { ...x, state: 'done' } : x)))
        return outcome && `${only}: ${outcome}`
      }),
    )
    const problems = outcomes.filter(Boolean)
    onSaved(problems.length ? `refresh: ${problems.join('; ')}` : null)
  }

  useInput((input, key) => {
    if (progress) return
    const row = accounts[cursor]
    if (editing !== null) {
      if (key.escape) setEditing(null)
      else if (key.return && row) {
        commit(row, editing)
        setCursor((c) => Math.min(accounts.length, c + 1))
      } else if (key.backspace || key.delete) setEditing(editing.slice(0, -1))
      else if (input && !key.ctrl && !key.meta && !key.tab) setEditing(editing + input)
      return
    }
    if (key.escape || input === 'q') onCancel()
    else if (input === 'j' || key.downArrow || key.tab)
      setCursor((c) => Math.min(accounts.length, c + 1))
    else if (input === 'k' || key.upArrow) setCursor((c) => Math.max(0, c - 1))
    else if (input === ' ' && row) {
      if (row.value) update(row.ecosystem, (r) => ({ ...r, checked: !r.checked }))
      else setEditing('')
    } else if (key.return) {
      setNotice(null)
      if (row) setEditing(row.value)
      else void save()
    }
  })

  const view: OnboardingView = {
    rows: accounts,
    cursor,
    editing,
    progress,
    notice,
    tick,
    reconfigure,
  }
  return <Lines lines={onboardingFrame(view, cols, rows)} cols={cols} rows={rows} />
}

/**
 * The accounts screen and the dashboard in one app. A first launch, or `qplex init`, opens
 * on the accounts and lands on the dashboard once saved; `a` on the dashboard comes back.
 */
export function Root({
  start,
  onProbe = probe,
  onRefresh = refresh,
  onRefreshTargets = refreshTargets,
}: {
  start: 'dashboard' | 'accounts'
  onProbe?: Probe
  onRefresh?: Refresh
  onRefreshTargets?: (targets: Target[]) => Promise<RefreshOutcome>
}) {
  const { exit } = useApp()
  const [screen, setScreen] = useState(start)
  /** Whether a dashboard was open when the accounts screen was, for escape to return to. */
  const [fromDashboard, setFromDashboard] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  if (screen === 'accounts') {
    return (
      <Onboarding
        reconfigure={configured()}
        onProbe={onProbe}
        onRefresh={onRefresh}
        onSaved={(n) => {
          setNotice(n)
          setScreen('dashboard')
        }}
        onCancel={fromDashboard ? () => setScreen('dashboard') : exit}
      />
    )
  }
  const accounts = () => {
    setFromDashboard(true)
    setScreen('accounts')
  }
  return (
    <App
      onRefresh={onRefresh}
      onRefreshTargets={onRefreshTargets}
      onAccounts={accounts}
      notice={notice}
    />
  )
}
