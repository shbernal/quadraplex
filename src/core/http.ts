import { readCache, writeCache, type Cache } from './store.ts'
import pkg from '../../package.json' with { type: 'json' }

/**
 * npm and pypistats are free services. An anonymous client that hammers them is how a
 * tool gets blocked, so every request identifies itself and every 429 is respected.
 */
const USER_AGENT = `quadraplex/${pkg.version} (+${pkg.repository.url})`

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

/**
 * Entries are only ever added, so merging over what is on disk lets refreshes running in
 * parallel processes each keep what the others learned.
 */
export function flushCache(): void {
  if (cache && dirty) {
    writeCache({ ...readCache(), ...cache })
    dirty = false
  }
}

export function resetHttpCache(): void {
  cache = null
  dirty = false
}

/** Carries the status, so a caller can tell "this does not exist" from "this failed". */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

/** QUADRAPLEX_DEBUG_HTTP=1 traces every request, which is how the 304 rate is checked. */
function trace(status: number, url: string, headers: Headers): void {
  if (!process.env.QUADRAPLEX_DEBUG_HTTP) return
  const remaining = headers.get('x-ratelimit-remaining')
  process.stderr.write(`${status} ${url}${remaining ? ` (quota left ${remaining})` : ''}\n`)
}

/** The longest a request waits on a server's say-so before it gives up instead. */
const MAX_WAIT_MS = 30_000

/**
 * A server's `Retry-After`, in seconds or as an HTTP date, is a floor on the wait and never
 * shortens the usual backoff. Null means the server asked for longer than is worth waiting,
 * and the attempt fails rather than retrying early.
 */
function backoffMs(attempt: number, retryAfter: string | null, floor = 0): number | null {
  const backoff = Math.max(Math.min(500 * 2 ** attempt, 8000), floor)
  if (!retryAfter) return backoff
  const seconds = Number(retryAfter)
  const asked = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
  if (Number.isNaN(asked)) return backoff
  return asked > MAX_WAIT_MS ? null : Math.max(backoff, asked)
}

/**
 * A 429 is a rate window, and npm's says `Retry-After: 0` while it is still closed, so a
 * retry within a second or two only spends more of the budget. A rate limited request
 * waits out roughly one window, once.
 */
const RATE_WINDOW_MS = 20_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type GetOptions = {
  accept?: string
  /** Send If-None-Match and treat a 304 as "the caller's stored copy is still current". */
  conditional?: boolean
  token?: string
  attempts?: number
  /** Per attempt. A peer that holds the socket open and sends nothing is a failed attempt. */
  timeoutMs?: number
  /** The least a 429 waits before its single retry. */
  rateWindowMs?: number
}

const TIMEOUT_MS = 20_000

/**
 * One request loop for every content type. Retries, conditional headers and the ETag
 * bookkeeping are identical whether the body is JSON or a store page, and only the last
 * step of turning a body into a value differs.
 */
async function send(
  url: string,
  options: GetOptions,
  fallbackAccept: string,
  payload?: { body: string; contentType: string },
): Promise<{
  status: number
  body: globalThis.Response | null
  headers: Headers
  /** Stores the response's validator. Called once the body has parsed, never before. */
  remember: () => void
}> {
  const attempts = options.attempts ?? 4
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: options.accept ?? fallbackAccept,
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (payload) headers['content-type'] = payload.contentType

  const entry = options.conditional ? cacheState()[url] : undefined
  if (entry?.etag) headers['if-none-match'] = entry.etag
  else if (entry?.lastModified) headers['if-modified-since'] = entry.lastModified

  let lastError: unknown
  let throttled = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: globalThis.Response
    try {
      // An abort closes the socket, where racing a timer would leave it open.
      response = await fetch(url, {
        method: payload ? 'POST' : 'GET',
        body: payload?.body ?? null,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1) break
      await sleep(backoffMs(attempt, null)!)
      continue
    }

    const limited = response.status === 429
    if (RETRYABLE.has(response.status) && attempt < attempts - 1 && !(limited && throttled)) {
      const floor = limited ? (options.rateWindowMs ?? RATE_WINDOW_MS) : 0
      const wait = backoffMs(attempt, response.headers.get('retry-after'), floor)
      if (wait !== null) {
        throttled ||= limited
        await sleep(wait)
        continue
      }
    }

    if (response.status === 304) {
      trace(304, url, response.headers)
      return { status: 304, body: null, headers: response.headers, remember: () => {} }
    }
    trace(response.status, url, response.headers)

    if (!response.ok) {
      throw new HttpError(response.status, `${response.status} ${response.statusText} for ${url}`)
    }

    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    // A validator stored for a body that then failed to parse would answer the next run
    // with a 304 and nothing behind it.
    const remember = () => {
      if (!options.conditional || !(etag || lastModified)) return
      const record: Cache[string] = { fetchedAt: new Date().toISOString() }
      if (etag) record.etag = etag
      if (lastModified) record.lastModified = lastModified
      cacheState()[url] = record
      dirty = true
    }

    return { status: response.status, body: response, headers: response.headers, remember }
  }

  throw new Error(`request to ${url} failed`, { cause: lastError })
}

export async function getJson<T>(url: string, options: GetOptions = {}): Promise<Response<T>> {
  const { status, body, headers, remember } = await send(url, options, 'application/json')
  const data = body ? ((await body.json()) as T) : null
  remember()
  return { status, notModified: body === null, data, headers }
}

export async function getText(url: string, options: GetOptions = {}): Promise<Response<string>> {
  const { status, body, headers, remember } = await send(url, options, 'text/html')
  const data = body ? await body.text() : null
  remember()
  return { status, notModified: body === null, data, headers }
}

/** For an RPC endpoint, so only for calls that are safe to repeat on a retry. */
export async function postText(
  url: string,
  body: string,
  contentType: string,
  options: Omit<GetOptions, 'conditional'> = {},
): Promise<Response<string>> {
  const payload = { body, contentType }
  const sent = await send(url, options, 'text/xml', payload)
  const data = sent.body ? await sent.body.text() : null
  return { status: sent.status, notModified: false, data, headers: sent.headers }
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
