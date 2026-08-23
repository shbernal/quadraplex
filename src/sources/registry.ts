import type { Ecosystem } from '../core/types.ts'
import type { Source } from './types.ts'
import { npmSource } from './npm.ts'
import { pypiSource } from './pypi.ts'
import { githubSource } from './github.ts'

export const sources: Partial<Record<Ecosystem, Source>> = {
  npm: npmSource,
  pypi: pypiSource,
  github: githubSource,
}

export function sourceFor(ecosystem: Ecosystem): Source {
  const source = sources[ecosystem]
  if (!source) throw new Error(`no source is registered for ${ecosystem}`)
  return source
}
