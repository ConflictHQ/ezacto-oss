---
name: pm
description: PM assistant bridging Slack and this repo's GitHub issues — pull action items out of a channel into well-formed issues (classify + dedup), nudge a maintainer through a config-driven user map, or broadcast a status update built from the live tracker. Use when triaging a channel into issues, chasing an owner, or posting status. Skip for a single already-specified issue (plain `gh` is faster), for editing existing issue text, and when no Slack channel is involved.
---

# /pm — Slack ↔ GitHub PM assistant

This skill mirrors [`.claude/skills/pm/SKILL.md`](../../../.claude/skills/pm/SKILL.md)
— read and follow that file for the full procedure (`pull` / `nudge` /
`broadcast`, including the classification, the dedup rule, the curl and gh
recipes, and the confirm gate). The content is kept in one place so the two
runtimes cannot drift.

**Usage:** `/pm pull [<channel>] [--limit N]` · `/pm nudge <github-login-or-name> [#issue] [message]` · `/pm broadcast [<channel>] [message]`

Quick reference:

- **Confirm before any write** — preview the issue title, body and labels, or
  the message text and its destination, then wait for a yes. Never auto-fire.
- **Config-driven, zero hardcoded identities.** Slack token from
  `SLACK_BOT_TOKEN` (stop if unset); repo from `gh repo view --json
  nameWithOwner`; people and channels from the one
  `.claude/skills/pm/users.json`, which both runtimes read and which ships empty.
- **pull** classifies messages (decision / action item / open question / FYI) and
  opens issues from the action items **dedup-safe** — check cited `#numbers` and
  the open issue list first — or appends the non-code items to `memory/`.
- **nudge / broadcast** resolve people and channels from config; broadcast builds
  its status from the live tracker (`gh issue list`, `gh pr list`) plus
  `memory/decisions.md` and `memory/open-questions.md`.
- Use the repo's existing labels (`gh label list`); `money`, `auth`, `migration`
  and `invariants` raise the review tier in `agents/sdlc-routing.json`, so apply
  them only when true.
- **No AI attribution** on issues, comments, or commits.
