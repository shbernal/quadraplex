import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config } from '../src/core/config.ts'
import { resetHttpCache } from '../src/core/http.ts'
import { pypiSource } from '../src/sources/pypi.ts'
import { Gone } from '../src/sources/types.ts'

let dir: string
let warehouse: Record<string, unknown>
let overall: { category: string; date: string; downloads: number }[]
let requested: string[]
let rpc: string
let posted: { body: string; type: string | null } | null
let missing: string | null
const realFetch = globalThis.fetch

function point(category: string, date: string, downloads: number) {
  return { category, date, downloads }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quadraplex-'))
  process.env.QUADRAPLEX_HOME = dir
  resetHttpCache()
  requested = []
  warehouse = {
    info: { version: '1.2.0', summary: 'A thing', project_urls: null, home_page: null },
    urls: [],
  }
  overall = []
  rpc = ''
  posted = null
  missing = null
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const href = url.toString()
    requested.push(href)
    if (init?.method === 'POST') {
      posted = { body: init.body as string, type: new Headers(init.headers).get('content-type') }
      return new Response(rpc, { headers: { 'content-type': 'text/xml' } })
    }
    if (missing && href.includes(missing)) return Response.json({}, { status: 404 })
    return Response.json(href.includes('pypistats') ? { data: overall } : warehouse)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUADRAPLEX_HOME
})

const fetchPkg = (name = 'pkg') =>
  pypiSource.fetch({ name, discovered: 'config' }, structuredClone(DEFAULT_CONFIG))

function rows(...pairs: [string, string][]): string {
  const entries = pairs.map(
    ([role, name]) =>
      `<value><array><data>\n<value><string>${role}</string></value>\n<value><string>${name}</string></value>\n</data></array></value>`,
  )
  return `<?xml version='1.0'?>\n<methodResponse>\n<params>\n<param>\n<value><array><data>\n${entries.join('\n')}\n</data></array></value>\n</param>\n</params>\n</methodResponse>`
}

const discover = (accounts: Config['accounts'] = { pypi: 'shbernal' }) =>
  pypiSource.discover({ ...structuredClone(DEFAULT_CONFIG), accounts })

test('discovery asks user_packages for the account, once per package across roles', async () => {
  rpc = rows(['Owner', 'a'], ['Maintainer', 'b'], ['Maintainer', 'a'])
  expect(await discover({ pypi: 'you&me' })).toEqual([
    { name: 'a', discovered: 'auto' },
    { name: 'b', discovered: 'auto' },
  ])
  expect(requested).toEqual(['https://pypi.org/pypi'])
  expect(posted!.type).toBe('text/xml')
  expect(posted!.body).toContain('<methodName>user_packages</methodName>')
  expect(posted!.body).toContain('<string>you&amp;me</string>')
})

test('an account with no packages discovers nothing', async () => {
  rpc = rows()
  expect(await discover()).toEqual([])
})

test('no pypi account skips discovery without a request', async () => {
  expect(await discover({ npm: 'you' })).toEqual([])
  expect(requested).toEqual([])
})

test('a fault or a non XML-RPC answer fails discovery rather than emptying it', async () => {
  rpc = `<?xml version='1.0'?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>-32601</int></value></member><member><name>faultString</name><value><string>method not found</string></value></member></struct></value></fault></methodResponse>`
  expect(discover()).rejects.toThrow(/method not found/)
  rpc = '<html>Challenge</html>'
  expect(discover()).rejects.toThrow(/no XML-RPC result/)
})

test('only the without_mirrors series is counted', async () => {
  overall = [
    point('with_mirrors', '2026-08-02', 100),
    point('without_mirrors', '2026-08-02', 4),
    point('with_mirrors', '2026-08-01', 100),
    point('without_mirrors', '2026-08-01', 3),
  ]
  const { snapshot, series } = await fetchPkg()
  expect(series).toEqual([
    { date: '2026-08-01', downloads: 3 },
    { date: '2026-08-02', downloads: 4 },
  ])
  expect(snapshot.metrics.downloadsDay).toBe(4)
  expect(snapshot.metrics.downloadsWeek).toBe(7)
})

test('an empty series is unknown downloads, not zero', async () => {
  const { snapshot } = await fetchPkg()
  expect(snapshot.metrics.downloadsDay).toBeNull()
  expect(snapshot.metrics.downloadsWeek).toBeNull()
  expect(snapshot.metrics.downloadsMonth).toBeNull()
})

test('a source link wins over a tracker or docs link into another repo', async () => {
  warehouse.info = {
    version: '1',
    project_urls: {
      'Bug Tracker': 'https://github.com/someone/else/issues',
      Documentation: 'https://example.test/docs',
      Source: 'https://github.com/shbernal/pkg',
    },
  }
  expect((await fetchPkg()).snapshot.links).toEqual(['gh:shbernal/pkg'])
})

test('any GitHub project url is used when none names the source', async () => {
  warehouse.info = {
    version: '1',
    project_urls: { Docs: 'https://example.test', Homepage: 'https://github.com/shbernal/pkg' },
  }
  expect((await fetchPkg()).snapshot.links).toEqual(['gh:shbernal/pkg'])
})

test('home_page is the fallback when project_urls has no GitHub link', async () => {
  warehouse.info = { version: '1', home_page: 'https://github.com/shbernal/pkg' }
  expect((await fetchPkg()).snapshot.links).toEqual(['gh:shbernal/pkg'])
})

test('lastPublish is the newest upload of the release', async () => {
  warehouse.urls = [
    { upload_time_iso_8601: '2026-08-01T10:00:00Z' },
    { upload_time_iso_8601: '2026-08-01T10:05:00Z' },
    { upload_time_iso_8601: '2026-08-01T09:59:00Z' },
  ]
  expect((await fetchPkg()).snapshot.metrics.lastPublish).toBe('2026-08-01T10:05:00Z')
})

test('the name is encoded in every url, the stored one included', async () => {
  const { snapshot, detail } = await fetchPkg('a b')
  expect(snapshot.url).toBe('https://pypi.org/project/a%20b/')
  expect(requested.every((url) => url.includes('a%20b'))).toBe(true)
  expect(detail).toEqual({ description: 'A thing' })
})

test('only a 404 from the package itself means gone, never one from the stats service', async () => {
  missing = 'pypi.org/pypi/pkg/json'
  expect(fetchPkg()).rejects.toBeInstanceOf(Gone)
  missing = 'pypistats'
  const failure = await fetchPkg().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(Gone)
})
