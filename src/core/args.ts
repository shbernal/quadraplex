export class UsageError extends Error {}

export type Parsed = {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

const VALUE_FLAGS = new Set([
  'only',
  'handle',
  'npm',
  'pypi',
  'github',
  'ghcr',
  'amo',
  'cws',
  'clawhub',
  'dockerhub',
  'rubygems',
])

export function parseArgv(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const flag = arg.replace(/^--?/, '')
    const eq = flag.indexOf('=')
    const name = eq < 0 ? flag : flag.slice(0, eq)
    const inline = eq < 0 ? undefined : flag.slice(eq + 1)
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
      flags[name] = value
    } else {
      flags[name] = inline ?? true
    }
  }

  return { command: positionals.shift() ?? '', positionals, flags }
}
