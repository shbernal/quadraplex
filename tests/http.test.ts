import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from '../src/core/errors.ts'
import { flushCache, getJson, resetHttpCache } from '../src/core/http.ts'
import { readCache } from '../src/core/store.ts'

const realFetch = globalThis.fetch

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

test('a peer that never answers fails the request instead of hanging it', async () => {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
  const started = Date.now()
  const error = await getJson('https://example.test/hang', { timeoutMs: 50, attempts: 1 }).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a request that cannot connect keeps the reason in its message chain', async () => {
  globalThis.fetch = (() =>
    Promise.reject(
      Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }),
    )) as unknown as typeof fetch
  const error = await getJson('https://example.test/x', { attempts: 1 }).catch((e: unknown) => e)
  expect(describe(error)).toBe(
    'request to https://example.test/x failed: Unable to connect (ConnectionRefused)',
  )
})

test('a validator is not stored for a body that failed to parse', async () => {
  globalThis.fetch = (async () =>
    new Response('{ truncated', { headers: { etag: '"v1"' } })) as unknown as typeof fetch
  await getJson('https://example.test/x', { conditional: true }).catch(() => null)
  flushCache()
  expect(readCache()).toEqual({})
})

test('a Retry-After past the ceiling fails at once instead of retrying early', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('slow down', { status: 429, headers: { 'retry-after': '600' } })
  }) as unknown as typeof fetch
  const error = await getJson('https://example.test/x').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  expect(calls).toBe(1)
})

test('a zero Retry-After still waits the usual backoff', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return calls === 1
      ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
      : Response.json({ ok: true })
  }) as unknown as typeof fetch
  const started = Date.now()
  expect((await getJson('https://example.test/x')).data).toEqual({ ok: true })
  expect(Date.now() - started).toBeGreaterThanOrEqual(450)
})

test('a rate limit waits out its window once, then gives up rather than spend more of it', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
  }) as unknown as typeof fetch
  const started = Date.now()
  const error = await getJson('https://example.test/x', { rateWindowMs: 300 }).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(calls).toBe(2)
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
})
