import { parseArgv, UsageError } from './core/args.ts'
import { configured } from './core/config.ts'
import { causeChain } from './core/errors.ts'
import { HELP } from './core/help.ts'
import { rejectUnscopedFresh } from './commands/guards.ts'
import { completionNames, completionScript } from './commands/completions.ts'
import { listPayload, listTable, parseEcosystem } from './commands/list.ts'
import { statusPayload, statusTable } from './commands/status.ts'
import { refresh, refreshSummary } from './commands/refresh.ts'
import { TARGET_COMMANDS, targetPayload, targetText } from './commands/target.ts'
import pkg from '../package.json' with { type: 'json' }

const interactive = () => process.stdout.isTTY && process.stdin.isTTY

/** The text renderer runs only when asked for, so a bug in it cannot take down `--json`. */
function print<T>(json: boolean, payload: T, text: (payload: T) => string): void {
  console.log(json ? JSON.stringify(payload, null, 2) : text(payload))
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
      if (flags.curves) {
        const { curvesSummary, refreshCurves } = await import('./commands/curves.ts')
        const curves = await refreshCurves()
        print(json, curves, curvesSummary)
        return curves.failed.length > 0 && curves.built.length === 0 ? 1 : 0
      }
      const report = await refresh({ only: flags.only })
      print(json, report, refreshSummary)
      const failures = report.failed.length + report.discoveryFailed.length
      return failures > 0 && report.ok === 0 ? 1 : 0
    }
    case 'status': {
      rejectUnscopedFresh('status', flags)
      const payload = statusPayload()
      print(json, payload, statusTable)
      return 0
    }
    case 'list': {
      rejectUnscopedFresh('list', flags)
      const payload = listPayload(parseEcosystem(positionals[0]))
      print(json, payload, listTable)
      return 0
    }
    case 'init': {
      const init = await import('./commands/init.ts')
      if (flags.suggest) {
        print(json, await init.suggest(flags), init.suggestTable)
        return 0
      }
      const changes = init.accountFlags(flags)
      if (!changes && !json && interactive()) {
        const { startDashboard } = await import('./tui/index.ts')
        await startDashboard('accounts')
        return 0
      }
      if (!changes) throw new UsageError(init.INIT_USAGE)
      print(json, init.writeAccounts(changes), init.initText)
      return 0
    }
    case 'completions':
      console.log(completionScript(positionals[0]))
      return 0
    case '__complete':
      for (const name of completionNames(positionals[0])) console.log(name)
      return 0
    case '': {
      rejectUnscopedFresh('status', flags)
      // A piped invocation must never enter raw mode, so it degrades to the status table.
      if (!json && interactive()) {
        const { startDashboard } = await import('./tui/index.ts')
        await startDashboard(configured() ? 'dashboard' : 'accounts')
        return 0
      }
      const payload = statusPayload()
      print(json, payload, statusTable)
      return 0
    }
    default: {
      const ecosystem = TARGET_COMMANDS[command]
      if (!ecosystem) throw new UsageError(`unknown command "${command}"\n\n${HELP}`)
      const payload = await targetPayload(ecosystem, positionals[0], flags.fresh === true)
      print(json, payload, targetText)
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
    const [message, ...causes] = causeChain(error)
    console.error(message)
    for (const cause of causes) console.error(`  caused by: ${cause}`)
    if (process.env.QUADRAPLEX_DEBUG && error instanceof Error && error.stack) {
      console.error(error.stack)
    }
    process.exitCode = 1
  }
}
