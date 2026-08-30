import { expect, test } from 'bun:test'
import { lastPageFrom, recentStargazers, sampleIndexes, samplePages } from '../src/sources/stars.ts'

const LINK =
  '<https://api.github.com/repositories/1/stargazers?per_page=100&page=2>; rel="next", ' +
  '<https://api.github.com/repositories/1/stargazers?per_page=100&page=347>; rel="last"'

test('the page count comes out of the Link header, and a single page has no header', () => {
  expect(lastPageFrom(LINK)).toBe(347)
  expect(lastPageFrom(null)).toBe(1)
  expect(lastPageFrom('<https://api.github.com/x?page=2>; rel="next"')).toBe(1)
})

test('sampled pages always include page one and never exceed the last page', () => {
  const pages = samplePages(347)
  expect(pages[0]).toBe(1)
  expect(Math.max(...pages)).toBeLessThanOrEqual(347)
  expect(pages).toEqual(pages.toSorted((a, b) => a - b))
  expect(pages.length).toBeLessThanOrEqual(17)
  expect(new Set(pages).size).toBe(pages.length)
})

test('a repo with exactly one page of stargazers samples that page alone', () => {
  expect(samplePages(1)).toEqual([1])
})

test('the small repo path strides the flattened list and always starts at the first star', () => {
  expect(sampleIndexes(320)[0]).toBe(0)
  expect(sampleIndexes(320)).toHaveLength(16)
  expect(sampleIndexes(5)).toEqual([0, 1, 2, 3, 4])
  expect(sampleIndexes(0)).toEqual([])
})

const AT = (day: number) => `2026-0${day}-01T00:00:00Z`

test('the roster comes back newest first and drops entries with no user attached', () => {
  const people = recentStargazers([
    { starred_at: AT(1), user: { login: 'first', html_url: 'https://github.com/first' } },
    { starred_at: AT(3), user: null },
    { starred_at: AT(2), user: { login: 'second', html_url: 'https://github.com/second' } },
  ])
  expect(people.map((p) => p.login)).toEqual(['second', 'first'])
  expect(people[0]!.starredAt).toBe(AT(2))
})

test('a login seen on two sampled pages keeps its most recent star, and the cap holds', () => {
  const entries = [
    { starred_at: AT(1), user: { login: 'dup' } },
    { starred_at: AT(4), user: { login: 'dup' } },
    { starred_at: AT(2), user: { login: 'other' } },
  ]
  expect(recentStargazers(entries)).toEqual([
    { login: 'dup', url: 'https://github.com/dup', starredAt: AT(4) },
    { login: 'other', url: 'https://github.com/other', starredAt: AT(2) },
  ])
  expect(recentStargazers(entries, 1).map((p) => p.login)).toEqual(['dup'])
  expect(recentStargazers([])).toEqual([])
})
