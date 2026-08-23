# 0003: Hand-written npm response types, not `@npm/types`

Status: accepted, 2026-10-07

## Context

`sources/npm.ts` reads three npm endpoints: registry search, the packument and the
downloads API. Each one is typed by hand with only the fields quadraplex reads. The
packument uses five of them. `@npm/types` is npm's own types-only package. It covers the
packument and the manifest, and it does not cover search or downloads.

## Decision

Keep the hand-written types.

- It would replace one of the three shapes. Search hits and download ranges would still be
  typed by hand.
- It is stricter than the registry. In `@npm/types`, `time` and `versions` are required, and
  the `repository` hoisted onto the packument is object-only. Unpublished packages come back
  without `versions`, and old packages still publish `repository` as a plain string. The
  local type marks all of these optional or a union, and the code narrows them.
- Five fields are small enough to check by eye, which is the same threshold ADR 0001 sets
  for GitHub.

## Revisit when

quadraplex reads much more of the packument, such as per-version manifests, `dist`,
maintainers or engines, so the hand-written shape stops being small enough to check by eye.
