import { expect, test } from 'bun:test'
import { lastPageFrom, sampleIndexes, samplePages } from '../src/sources/stars.ts'

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
