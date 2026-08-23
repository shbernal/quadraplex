import { parseArgv, UsageError } from './core/args.ts'
import { HELP } from './core/help.ts'
import { rejectUnscopedFresh } from './commands/guards.ts'
import { listPayload, listTable, parseEcosystem } from './commands/list.ts'
import { statusPayload, statusTable } from './commands/status.ts'
import { refresh, refreshSummary } from './commands/refresh.ts'
import { TARGET_COMMANDS, targetPayload, targetText } from './commands/target.ts'
import pkg from '../package.json' with { type: 'json' }

function print(json: boolean, payload: unknown, text: string): void {
  console.log(json ? JSON.stringify(payload, null, 2) : text)
}

export async function run(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgv(argv)
  const json = flags.json === true

  if (flags.help || flags.h || command === 'help') {
    console.log(HELP)
    return 0
  }
  if (flags.version || flags.v) {
    console.log(pkg.version)
    return 0
  }

  switch (command) {
    case 'refresh': {
      const report = await refresh({ only: flags.only })
      print(json, report, refreshSummary(report))
      return report.failed.length > 0 && report.ok === 0 ? 1 : 0
    }
    case 'status': {
      rejectUnscopedFresh('status', flags)
      const payload = statusPayload()
      print(json, payload, statusTable(payload))
      return 0
    }
    case 'list': {
      rejectUnscopedFresh('list', flags)
      const payload = listPayload(parseEcosystem(positionals[0]))
      print(json, payload, listTable(payload))
      return 0
    }
    case '': {
      // A piped invocation must never enter raw mode, so it degrades to the status table.
      if (!json && process.stdout.isTTY && process.stdin.isTTY) {
        const { startDashboard } = await import('./tui/index.ts')
        await startDashboard()
        return 0
      }
      const payload = statusPayload()
      print(json, payload, statusTable(payload))
      return 0
    }
    default: {
      const ecosystem = TARGET_COMMANDS[command]
      if (!ecosystem) throw new UsageError(`unknown command "${command}"\n\n${HELP}`)
      const payload = await targetPayload(ecosystem, positionals[0], flags.fresh === true)
      print(json, payload, targetText(payload))
      return 0
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  try {
    process.exitCode = await run(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
