/** One release line and the versions that carried its downloads, busiest first. */
export type Track = {
  name: string
  downloads: number
  versions: { version: string; downloads: number }[]
}

/**
 * A release is stable unless it has a prerelease part, and the track is that part's first
 * word: `0.2.2-next.5.g8622dc3` is `next`, `1.0.0-rc1` is `rc`. A purely numeric one has
 * no name to give, so it files under `prerelease`. Derived on read so the stored split
 * stays the registry's own and a better grouping applies to old readings too.
 */
function trackOf(version: string): string {
  const pre = /^[^-+]*-([^+]*)/.exec(version)?.[1]
  if (pre === undefined) return 'stable'
  return pre.split('.')[0]!.replace(/\d+$/, '') || 'prerelease'
}

/** Stable first, then by downloads. */
export function tracks(versions: Record<string, number>): Track[] {
  const byName = new Map<string, Track>()
  for (const [version, downloads] of Object.entries(versions)) {
    const name = trackOf(version)
    const track = byName.get(name) ?? { name, downloads: 0, versions: [] }
    track.downloads += downloads
    track.versions.push({ version, downloads })
    byName.set(name, track)
  }
  const all = [...byName.values()]
  for (const track of all) track.versions.sort((a, b) => b.downloads - a.downloads)
  return all.toSorted(
    (a, b) =>
      Number(b.name === 'stable') - Number(a.name === 'stable') || b.downloads - a.downloads,
  )
}
