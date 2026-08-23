import { expect, test } from 'bun:test'
import { tracks } from '../src/core/tracks.ts'

test('versions split into stable and named prerelease tracks, stable first', () => {
  const split = tracks({
    '0.2.2-next.5.g8622dc3': 98,
    '0.2.1': 690,
    '0.2.2-next.6.g64abb35': 110,
    '0.1.0': 6,
    '1.0.0-rc1': 400,
    '1.0.0-20240101': 1,
    '1.0.0+build.5': 3,
  })
  expect(split.map((t) => [t.name, t.downloads])).toEqual([
    ['stable', 699],
    ['rc', 400],
    ['next', 208],
    ['prerelease', 1],
  ])
  expect(split[2]!.versions[0]).toEqual({ version: '0.2.2-next.6.g64abb35', downloads: 110 })
})
