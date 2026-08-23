# 0002: Agent skills get their own pane once ClawHub is configured

Status: accepted, 2026-10-05

## Context

skills.sh counts installs of the SKILL.md files in a repo. It has no publish step, so its
count rides on the `gh:` target and shows as one column of the GitHub pane. ClawHub is an
ecosystem: a skill is published there under a publisher handle, with its own versions and
counts, and a repo is never named. It is less used than skills.sh, so most portfolios have
only the one store.

Putting ClawHub skills in the registries pane would add installs to a header that sums
weekly downloads, and a skill's total across skills.sh and ClawHub would have to be added up from
two rows in two panes.

## Decision

- ClawHub is its own ecosystem, `clawhub:<slug>`, with an account, a TTL and retirement,
  like any store.
- With a ClawHub account, a Skills pane joins the board: one row per skill, since a repo can
  hold several and ClawHub publishes them one by one. Columns are skills.sh installs,
  ClawHub installs, ClawHub's delta and their sum. The border carries both totals and the
  combined one. The GitHub pane drops its skill column, so no count is shown twice.
- Without a ClawHub account the board is unchanged.
- A ClawHub skill joins a repo's project when the repo publishes a skill with the same slug.
  This is derived at read time in the dashboard and is not stored, and a config `links`
  entry replaces it.
- Installs from skills.sh and ClawHub are added together. Both count users whose CLI reported an
  install, and ClawHub discards skills.sh's events. A skill unknown to both stays unknown,
  never zero.
- Discovery calls the Convex query ClawHub's publisher page uses, because the documented
  API cannot list one publisher's skills. A broken query fails discovery, which falls back
  to known targets plus `include`.

## Revisit when

- ClawHub documents a per-publisher listing: move discovery to it.
- skills.sh exposes per-skill history: the Δ column can cover both.
- A third place counting skill installs appears: it becomes another column of the same pane.
