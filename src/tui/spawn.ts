import { spawn } from 'node:child_process'
import type { Ecosystem } from '../core/types.ts'
import type { RefreshReport } from '../commands/refresh.ts'
import type { SuggestPayload, Suggestion } from '../commands/init.ts'

/**
 * The TUI never fetches. Anything that touches the network runs this same CLI as a child
 * and reads its JSON back, so the "breadth comes from cache" rule holds for humans exactly
 * as it does for agents.
 */
function cli(args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1]!, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, err, code }))
  })
}

const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? ''

/** What a refresh changed beyond the numbers, as a line for the header, or null when nothing. */
export type RefreshOutcome = string | null

/**
 * Failures and retirements named by count, since the header has one line and `qplex
 * refresh` has the rest. A retired project leaves its pane, which must not pass silently.
 */
export function refreshOutcome(report: RefreshReport): RefreshOutcome {
  const parts: string[] = []
  if (report.failed.length) parts.push(`${report.failed.length} failed`)
  if (report.discoveryFailed.length) {
    parts.push(`${report.discoveryFailed.map((d) => d.ecosystem).join(', ')} discovery failed`)
  }
  if (report.retired.length) parts.push(`${report.retired.length} retired`)
  return parts.length ? parts.join(', ') : null
}

/** A failed refresh is read from its report, so it never looks like a quiet one. */
export async function refresh(only: Ecosystem | null): Promise<RefreshOutcome> {
  const args = only ? ['refresh', '--json', '--only', only] : ['refresh', '--json']
  try {
    const { out, err, code } = await cli(args)
    try {
      return refreshOutcome(JSON.parse(out) as RefreshReport)
    } catch {
      const last = lastLine(err)
      return `refresh exited ${code}${last ? `: ${last}` : ''}`
    }
  } catch (error) {
    return `refresh did not start: ${(error as Error).message}`
  }
}

/**
 * `--fresh` on each of one project's targets, which also rereads what a routine refresh
 * keeps cached. One at a time, since each rewrites the state.
 */
export async function refreshTargets(
  targets: { ecosystem: Ecosystem; name: string }[],
): Promise<RefreshOutcome> {
  const problems: string[] = []
  for (const { ecosystem, name } of targets) {
    try {
      const { err, code } = await cli([ecosystem, name, '--fresh', '--json'])
      if (code !== 0) problems.push(`${ecosystem} ${lastLine(err) || `exited ${code}`}`)
    } catch (error) {
      problems.push(`${ecosystem} did not start: ${(error as Error).message}`)
    }
  }
  return problems.length ? problems.join('; ') : null
}

/** `init --suggest` with the given account flags. Throws with the reason when it cannot run. */
export async function probe(flags: Record<string, string>): Promise<Suggestion[]> {
  const args = ['init', '--suggest', '--json']
  for (const [name, value] of Object.entries(flags)) args.push(`--${name}=${value}`)
  const { out, err, code } = await cli(args)
  try {
    return (JSON.parse(out) as SuggestPayload).suggestions
  } catch {
    throw new Error(lastLine(err) || `init exited ${code}`)
  }
}
