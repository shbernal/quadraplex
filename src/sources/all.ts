import type { Ecosystem } from '../core/types.ts'
import type { Source } from './types.ts'
import { npmSource } from './npm.ts'
import { pypiSource } from './pypi.ts'
import { githubSource } from './github.ts'
import { ghcrSource } from './ghcr.ts'
import { amoSource } from './amo.ts'
import { cwsSource } from './cws.ts'
import { clawhubSource } from './clawhub.ts'
import { dockerhubSource } from './dockerhub.ts'
import { rubygemsSource } from './rubygems.ts'
import { jsrSource } from './jsr.ts'

export const sources: Partial<Record<Ecosystem, Source>> = {
  npm: npmSource,
  pypi: pypiSource,
  github: githubSource,
  ghcr: ghcrSource,
  amo: amoSource,
  cws: cwsSource,
  clawhub: clawhubSource,
  dockerhub: dockerhubSource,
  rubygems: rubygemsSource,
  jsr: jsrSource,
}

export function sourceFor(ecosystem: Ecosystem): Source {
  const source = sources[ecosystem]
  if (!source) throw new Error(`no source is registered for ${ecosystem}`)
  return source
}
