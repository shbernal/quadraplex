# Skills

The agent-facing skill for quadraplex lives here so it versions with the CLI it describes.

```sh
npx skills add shbernal/quadraplex
```

It documents a specific `schemaVersion` and command surface. A skill that has drifted from
the tool it describes is worse than no skill, so `tests/skill.test.ts` fails the build when
the version pinned in `SKILL.md` stops matching the one the CLI emits.
