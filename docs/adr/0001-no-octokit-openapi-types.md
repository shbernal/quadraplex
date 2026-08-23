# 0001: Hand-written GitHub response types, not `@octokit/openapi-types`

Status: accepted, 2026-10-02

## Context

GitHub responses are typed by hand in the sources, as small shapes holding only the fields
quadraplex reads: about 25 across the repository, issue and stargazer objects.
`@octokit/openapi-types` is GitHub's REST spec turned into TypeScript, published weekly as a
single declaration file. It is types-only and would be a dev dependency with nothing at
runtime.

The Octokit client itself was ruled out first. `core/http.ts` serves npm and PyPI too, and
its ETags persist in `cache.json` across runs, which Octokit does not do.

## Decision

Keep the hand-written types.

- They already match the spec. All the repository fields used agree with
  `full-repository`, and where they differ (`pushed_at` nullable here, non-null in the spec),
  the more defensive local type is the one we want.
- The package does not catch the mistake that actually happens. The stargazers response is
  typed as `simple-user[] | stargazer[]` whatever the `Accept` header, so dropping the
  `star+json` media type still typechecks and still has to be narrowed by hand.
- The spec can be noisier than the API. Since early 2026, int64 fields are `number | bigint`.
- Churn outweighs coverage. It ships a major version every month or two (v26 to v29
  between 2025-09 and 2026-08), and the declaration file is 5 MB to type 25 fields.

## Revisit when

quadraplex reads many more GitHub endpoints or deep nested objects, so the hand-written
shapes stop being small enough to check by eye.
