---
name: pm
description: PM assistant bridging Slack and this repo's GitHub issues — pull action items out of a channel into well-formed issues (classify + dedup), nudge a maintainer through a config-driven user map, or broadcast a status update built from the live tracker. Use when triaging a channel into issues, chasing an owner, or posting status. Skip for a single already-specified issue (plain `gh` is faster), for editing existing issue text, and when no Slack channel is involved. Multi-agent (mirrored at .codex/skills/pm/).
---

# /pm — Slack ↔ GitHub PM assistant

Bridges a Slack channel and this repo's issues. Three actions — **pull**,
**nudge**, **broadcast** — all driven by config, with no people, channels, or
repos written into the skill.

**Usage:** `/pm pull [<channel>] [--limit N]` · `/pm nudge <github-login-or-name> [#issue] [message]` · `/pm broadcast [<channel>] [message]`

**Always confirm before creating an issue or sending a message.** Show exactly
what is about to happen — the issue title, body and labels, or the message text
and its destination — and wait for a yes. Nothing auto-fires.

## Setup — token and repo, read them, don't hardcode

**Slack token:** the `SLACK_BOT_TOKEN` environment variable. If it is unset, say
so and stop; do not go looking for one.

```bash
[ -n "$SLACK_BOT_TOKEN" ] || { echo "STOP: export SLACK_BOT_TOKEN=<bot-token> first"; }
```

**Repo and identity** come from the checkout — the same seam `/pr` uses:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
AUTHOR_EMAIL=$(git config user.email)
```

**People and channels** come from `.claude/skills/pm/users.json`. It ships
**empty** — a deployment fills it in. Both runtimes (`.claude` and `.codex`)
read that one file:

```bash
cat .claude/skills/pm/users.json
```

Shape:
```json
{ "github_to_slack": { "<github-login>": { "slack_id": "U<member-id>", "name": "…" } },
  "channels": { "<friendly-name>": "C<channel-id>" } }
```

If a person or a channel is not in the map and the Slack API cannot resolve it,
say so and ask for it to be added. Never invent a Slack ID.

---

## `/pm pull` — Slack channel → GitHub issues

Reads recent messages, classifies them, and offers to open issues (or to note
the item to `memory/`), **dedup-safe**.

1. **Resolve the channel ID.** Prefer the `channels` map; fall back to the API:
   ```bash
   curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
     "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200" | \
     python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['id'],c['name']) for c in d.get('channels',[]) if c['name']=='<NAME>']"
   ```

2. **Fetch recent messages** (default 50, or `--limit N`):
   ```bash
   curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
     "https://slack.com/api/conversations.history?channel=<CHANNEL_ID>&limit=50" | \
     python3 -c "
   import json,sys
   d=json.load(sys.stdin)
   for m in d.get('messages',[]):
       if m.get('type')=='message' and not m.get('bot_id') and m.get('text'):
           print(m.get('ts'), m.get('user','?'), m['text'][:200])
   "
   ```

3. **Classify** each substantive message:
   - **decision** — a choice was made ("we'll go with…", "agreed to…"). Belongs
     in `memory/decisions.md`, not in an issue.
   - **action item** — work to do ("we need to…", "can you…", "fix…", "add…").
     Candidate for a GitHub issue.
   - **open question** — unresolved ("not sure if…", "do we…?"). Belongs in
     `memory/open-questions.md`.
   - **FYI** — informational. Nothing to track.

4. **Dedup before proposing anything.** An action item is a duplicate if the
   message cites an issue number (`#1234` — check its state) or an open issue
   already covers it:
   ```bash
   gh issue view <#> --repo "$REPO" --json number,title,state,url
   gh issue list --repo "$REPO" --state open --limit 200 --json number,title,labels,url
   ```
   Mark each item **[NEW]**, **[ALREADY TRACKED #N]**, or **[NOT CODE → memory]**.

5. **Present the triage and confirm.** Nothing is created yet:
   ```
   Found N items in <channel>:

   1. [NEW] "Timer keeps running after the day rolls over" — from <person>
      → labels: <from the repo's own label list>   · create issue in <REPO>? (y/n)
   2. [ALREADY TRACKED #142] "queued email retries" — open, assigned to <login>
   3. [NOT CODE → memory] "we agreed the ledger stays append-only" → memory/decisions.md? (y/n)
   ```

6. **On confirmation**, create each approved issue:
   ```bash
   gh issue create --repo "$REPO" \
     --title "<imperative title>" \
     --body "<context — quote the Slack message and link it; what, why, acceptance>" \
     --label "<existing label>"
   ```
   - **Use the repo's own labels** (`gh label list --repo "$REPO"`); do not
     invent a scheme. `money`, `auth`, `migration` and `invariants` are load
     bearing — `agents/sdlc-routing.json` raises the review tier for them, so
     apply them when they are true and not otherwise.
   - **Write a real acceptance section.** `PROCESS.md` starts the build cycle at
     the issue and the acceptance criteria are an agent's success condition; an
     issue that says only "fix the thing" cannot be picked up.
   - **No AI attribution** in the body — no "generated by", no `Co-Authored-By`,
     no bot signature. The author is the gh-authenticated identity behind
     `$AUTHOR_EMAIL`.
   - For **[NOT CODE → memory]** items, append the entry to the matching
     `memory/*.md` file under a new stable ID (`d-NNN` / `q-NNN`) instead of
     opening an issue.

---

## `/pm nudge` — DM a maintainer

`/pm nudge <github-login-or-name> [#issue] [message]`

1. **Resolve the person** from `github_to_slack` by login or name (fuzzy is
   fine) → `slack_id`. Not in the map → ask for it; do not guess an ID.

2. If an `#issue` is given, fetch the context:
   ```bash
   gh issue view <#> --repo "$REPO" --json number,title,state,assignees,labels,url
   ```

3. **Compose a brief, human message.** A custom message goes first, with the
   issue context beneath it.

4. **Confirm the text and the recipient**, then open a DM and send:
   ```bash
   CH=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
     -d '{"users":"<SLACK_ID>"}' "https://slack.com/api/conversations.open" \
     | python3 -c "import json,sys;print(json.load(sys.stdin)['channel']['id'])")
   curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
     -d "{\"channel\":\"$CH\",\"text\":\"<MESSAGE>\"}" "https://slack.com/api/chat.postMessage"
   ```
   Confirm: "Sent to <name>."

**Batch nudge** ("everyone with an open issue in progress"): list the open
issues with assignees, group by assignee, resolve each through `users.json`, and
send one DM per person summarising their queue. Confirm the whole list first.

---

## `/pm broadcast` — post a status update

`/pm broadcast [<channel>] [message]`

1. **Pull the state from the live tracker**, not from a hand-kept summary:
   ```bash
   gh issue list --repo "$REPO" --state open --limit 200 --json number,title,assignees,labels,url
   gh pr list   --repo "$REPO" --state open --limit 50  --json number,title,author,isDraft,url
   ```
   Group into In Progress / In Review / Needs Owner. Recent decisions and live
   questions come from `memory/decisions.md` and `memory/open-questions.md`.

2. **Resolve the channel ID** from the `channels` map, else by name through the
   API as in pull step 1.

3. **Format plain Slack `mrkdwn`** — a dated status with those sections, each
   item `• #<num> <title> (<owner>)`. No branding or emoji baked into the skill.
   A custom message goes on top.

4. **Show the rendered message, confirm**, then post:
   ```bash
   curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
     -d "{\"channel\":\"<CHANNEL_ID>\",\"text\":\"<MESSAGE>\",\"mrkdwn\":true}" \
     "https://slack.com/api/chat.postMessage"
   ```
   Confirm: "Posted to <channel>."

---

## Conventions

- **Confirm before any write** — issue, DM, or channel post. Preview first.
- **Config-driven, zero hardcoded identities.** Token from the environment, repo
  from the checkout, people and channels from `users.json`. The skill itself
  carries no names, IDs, channels, or repos.
- **Dedup is mandatory on `pull`** — check cited `#numbers` and the open issues
  before proposing anything new.
- **The tracker is the source of truth.** If a message cites an issue, read its
  current state before acting on it.
- **No AI attribution** on issues, comments, or commits.

This skill is mirrored at `.codex/skills/pm/SKILL.md` (a thin pointer back here,
so the procedure lives in one place). Both runtimes read the one
`.claude/skills/pm/users.json`.
