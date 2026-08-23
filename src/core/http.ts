import { readCache, writeCache, type Cache } from './store.ts'
import pkg from '../../package.json' with { type: 'json' }

/**
 * npm and pypistats are free services. An anonymous client that hammers them is how a
 * tool gets blocked, so every request identifies itself and every 429 is respected.
 */
export const USER_AGENT = `quadraplex/${pkg.version} (+${pkg.repository.url})`

export type Response<T> = {
  status: number
  notModified: boolean
  data: T | null
  headers: Headers
}

let cache: Cache | null = null
let dirty = false

function cacheState(): Cache {
  cache ??= readCache()
  return cache
}

export function flushCache(): void {
  if (cache && dirty) {
    writeCache(cache)
    dirty = false
  }
}

export function resetHttpCache(): void {
  cache = null
  dirty = false
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

/** QUADRAPLEX_DEBUG_HTTP=1 traces every request, which is how the 304 rate is checked. */
function trace(status: number, url: string, headers: Headers): void {
  if (!process.env.QUADRAPLEX_DEBUG_HTTP) return
  const remaining = headers.get('x-ratelimit-remaining')
  process.stderr.write(`${status} ${url}${remaining ? ` (quota left ${remaining})` : ''}\n`)
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000)
  return Math.min(500 * 2 ** attempt, 8000)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type GetOptions = {
  accept?: string
  /** Send If-None-Match and treat a 304 as "the caller's stored copy is still current". */
  conditional?: boolean
  token?: string
  attempts?: number
}

export async function getJson<T>(url: string, options: GetOptions = {}): Promise<Response<T>> {
  const attempts = options.attempts ?? 4
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: options.accept ?? 'application/json',
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`

  const entry = options.conditional ? cacheState()[url] : undefined
  if (entry?.etag) headers['if-none-match'] = entry.etag
  else if (entry?.lastModified) headers['if-modified-since'] = entry.lastModified

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: globalThis.Response
    try {
      response = await fetch(url, { headers })
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1) break
      await sleep(backoffMs(attempt, null))
      continue
    }

    if (RETRYABLE.has(response.status) && attempt < attempts - 1) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')))
      continue
    }

    if (response.status === 304) {
      trace(304, url, response.headers)
      return { status: 304, notModified: true, data: null, headers: response.headers }
    }
    trace(response.status, url, response.headers)

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`)
    }

    if (options.conditional) {
      const etag = response.headers.get('etag')
      const lastModified = response.headers.get('last-modified')
      if (etag || lastModified) {
        const state = cacheState()
        const record: Cache[string] = { fetchedAt: new Date().toISOString() }
        if (etag) record.etag = etag
        if (lastModified) record.lastModified = lastModified
        state[url] = record
        dirty = true
      }
    }

    return {
      status: response.status,
      notModified: false,
      data: (await response.json()) as T,
      headers: response.headers,
    }
  }

  throw new Error(`request to ${url} failed`, { cause: lastError })
}

/** Runs tasks with a small concurrency cap so a portfolio refresh stays polite. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}
