---
name: memory-bootstrap
description: Build Frigidaire's first memory notes (per-person profiles and topic notes, circles, group notes) from the message archive export, with a lean orchestrator that runs one fresh subagent per step and resumes exactly where it stopped. Use when the owner asks to run, resume or check the memory bootstrap.
---

# Memory bootstrap playbook

Frigidaire keeps per-person markdown notes (a profile plus topic notes), circles (notes shared by a set of
members: an interest group, a sub-group, or a pair with a history) and group notes (docs/memory.md). The
nightly dream keeps them current from the journal; this playbook builds the FIRST notes from years of chat
history, so the bot starts out knowing people instead of learning them over months.

It reads the whole archive **in date order**, one chunk at a time, carrying knowledge forward (later chats
reference earlier ones: inside jokes, nicknames, "the Montreal thing again"). Every chunk is a small dream
over working notes, but what it learns also goes into an **append-only observation log**, so repeated
re-summarizing can never lose or distort history. Working notes are re-grounded from that log every 10
chunks, and the final notes are built from the log (not from the working notes), with every relationship
filed under everyone involved, then checked against the real messages.

**Privacy.** This runs on the owner's own Claude subscription. A consumer Claude plan is not
zero-data-retention: the chat history leaves the bot's ZDR-only setup for this one-off import. That is the
owner's informed choice for this route. The alternative that stays ZDR is the built-in bootstrap
(`yarn memory:bootstrap --dry-run`, then `--run`; see docs/memory.md). Never run this playbook unless the
owner asked for it.

## Before you start

1. **The export** comes from the bot's own container (it reads archive.db and memory.db there):
   ```bash
   docker exec -u node frigidaire-bot node dist/ai/memory/bootstrap/cli.js export
   docker cp frigidaire-bot:/app/data/memory-bootstrap/export ./data/memory-bootstrap/export
   ```
   (Locally with the bot's data folder: `yarn memory:export`.) It writes `manifest.json`, `people.json`,
   `months/YYYY-MM.md` and `chunks/NNNN.md`. Show the owner the manifest's totals (messages, chunks,
   estimated tokens) before starting: that is roughly what the scan reads.
2. **The helper commands** run from the repo root: `yarn memory <command>` when Node and the dependencies
   are installed, otherwise `docker compose run --rm test yarn memory <command>` (same arguments). Below,
   `memory …` means either form. Their paths are relative to the repo root: `memory observations` works on
   `data/memory-bootstrap/work` (its default; give that full path if you pass one, never a bare `work`).
3. `data/` is gitignored: everything here stays out of git. Never commit, paste or upload any of it.

## Folder layout

```
data/memory-bootstrap/
  export/                      read-only input (from the export command)
    manifest.json people.json months/ chunks/NNNN.md
  work/
    progress.json              the only state the orchestrator reads and writes
    steps/NNNN/                a committed scan step (observations.jsonl + working/…)
    observations/NNNN.jsonl    the append-only observation log, one file per chunk, never rewritten
    working/                   the working notes (an interpretation aid, same format as final notes)
      people/<id>/profile.md (+ topics)   group/<topic>.md   circles/<slug>.md
    by-person/<id>.jsonl, by-person/group.jsonl, by-person/index.json, by-circle/<slug>.jsonl, cast.md
                               derived views, rebuilt by `memory observations` (never edit them)
    eras/<id>/<from>_<to>.md   era summaries for people with very long logs
    final/                     the notes tree the bot imports (manifest.json, people/, group/, circles/)
    critic/report.md
```

## The orchestrator (you)

You stay lean so your context never fills up:
- You **never read** chunks, months, observations, working notes, final notes or by-person logs. You read
  only `export/manifest.json`, `work/progress.json`, `work/by-person/index.json` and the short output of the
  helper commands. You may list file names (`ls`).
- You launch **one fresh subagent per step** (the Agent/Task tool) with the prompt from this file, filled
  in with absolute paths. A subagent writes files and returns ONE line. You never paste file contents into a
  prompt: give paths.
- You record every finished step in `progress.json` (write `progress.json.tmp`, then `mv` it over), so a
  run interrupted by usage limits resumes exactly where it stopped.
- The scan is strictly sequential (each chunk builds on the notes before it). Final-build units are
  independent: run up to 4 at a time.
- Tell the owner in one short line what you are on every few steps (e.g. "scan 12/42").

### progress.json

```json
{
  "version": 1,
  "export": { "exported_at": "2026-09-26T21:00:00.000Z", "chunks": 42, "journal_high_water": 1234 },
  "scan": { "done": ["0001", "0002"] },
  "reground": { "every": 10, "after": ["0010"] },
  "final": { "circles": ["mtg"], "eras": ["100000000000000001:2016_2019"], "people": ["100000000000000001"], "group": false },
  "critic": false,
  "check": false
}
```

### The loop (also how to resume)

1. No `work/progress.json` → **init** (step 1): create `work/` and its subfolders (`steps`, `observations`,
   `working/people`, `working/group`, `working/circles`, `eras`, `final`, `critic`) and write
   progress.json from `export/manifest.json` (`exported_at`, the number of chunks, `journal_high_water`).
2. **Scan** every chunk listed in the manifest, in order. For the first chunk `N` not in `scan.done`:
   - `work/steps/N/` exists → the step committed but was not applied: **apply** it (below).
   - `work/steps/N.tmp/` exists → the step was interrupted: `rm -rf work/steps/N.tmp`, then scan `N` again.
   - Otherwise launch the **scan subagent** for `N`. When it returns, apply the step.
   - **Apply** (idempotent): `cp work/steps/N/observations.jsonl work/observations/N.jsonl` (when the step
     has no `observations.jsonl`, create an empty `work/observations/N.jsonl` instead), then
     `cp -R work/steps/N/working/. work/working/` (when that folder exists), then add `N` to `scan.done`.
   - After applying a chunk whose number is a multiple of `reground.every` (0010, 0020, …) and isn't in
     `reground.after`: **re-ground**, then add it to `reground.after`.
3. When every chunk is scanned: run `memory observations` (validates the log, rebuilds by-person/,
   by-circle/ and cast.md). Problems in the log are listed by file and line: have a fixer subagent correct
   those lines in `observations/NNNN.jsonl` (the one exception to append-only: fixing a malformed line),
   and run it again until it reports none.
4. **Final build**: circles, then people, then the group (see Step 4). Record each unit as it finishes.
5. **Critic** (Step 5), then **check** (Step 6), then write `work/final/manifest.json` and hand over.

## Step 2: scan one chunk

Launch a fresh subagent with this prompt (fill in `{EXPORT}` and `{WORK}` with absolute paths, `{N}` with
the chunk id, and `{FROM}`/`{TO}` with the chunk's dates from the manifest):

> You are one step of a sequential scan that builds long-term memory about a private Discord friend group
> from its chat history. Everything you need is in this prompt and the files below.
>
> Read, in this order:
> 1. `{EXPORT}/people.json`: transcript names → main ids (use the ids in everything you write), their other
>    names, real names and nicknames.
> 2. Every file under `{WORK}/working/` (the working notes so far: profiles, circles, group notes). They are
>    what earlier chunks learned; use them to interpret references.
> 3. `{EXPORT}/chunks/{N}.md` (chunk {N}, {FROM} → {TO}). Use the Read tool so you see line numbers. The
>    quoted lines under "ALREADY COVERED" are context from the previous chunk: never extract from them.
>
> Then write, and ONLY write, inside `{WORK}/steps/{N}.tmp/`:
> - `observations.jsonl`, ALWAYS (an empty file when the chunk has nothing worth keeping): one JSON object
>   per line, per the OBSERVATION FORMAT and the KNOWLEDGE RULES
>   below. Every observation is dated and cites the chunk lines it comes from (`"chunk": "{N}"`, line
>   numbers as the Read tool shows them). Interpret references with the working notes: a callback to an
>   earlier joke is recorded as that joke, with its origin. Relationships and shared events list everyone
>   involved in `people`. Tag an observation with `circle` when it belongs to a recurring shared thing
>   among specific people (an existing circle's slug, or a new slug).
> - `working/…`: the FULL new content of every working note you changed or created (same relative paths as
>   under `{WORK}/working/`, NOTE FORMAT below): merge what this chunk showed into the profiles of the people
>   it touched, their circles and the group notes, like a small dream (DREAM RULES below). Keep working
>   notes concise: profile ≤ 3,000 characters, circle ≤ 4,000, group topic ≤ 5,000. Do not write notes you
>   didn't change.
>
> When both are written, commit the step as your LAST action: `mv {WORK}/steps/{N}.tmp {WORK}/steps/{N}`.
> Reply with one line: `chunk {N}: <observations> observations, <notes> notes updated`. Nothing else.
>
> [paste here, verbatim: OBSERVATION FORMAT, KNOWLEDGE RULES, DREAM RULES, NOTE FORMAT, CIRCLE FORMAT]

(Pasting the reference sections into the prompt is fine: they are this playbook's rules, not chat content.)

## Step 3: re-ground (every 10 chunks)

Repeated re-summarizing drifts. Every 10 chunks, rebuild the working notes of everyone the last 10 chunks
touched from their FULL observation log, not from the previous notes:

1. Run `memory observations` (rebuilds by-person/, by-circle/, cast.md).
2. The people to re-ground: the ids that appear in `people` of the last 10 `observations/NNNN.jsonl` files.
   Have ONE small subagent list them (it may read those 10 files) and return the ids as one line; or re-ground
   everyone in `by-person/index.json` when that list is short.
3. For each id (up to 4 subagents at a time):

> Rebuild the working notes of person `{ID}` from their full observation log. Read `{EXPORT}/people.json`,
> `{WORK}/cast.md`, and `{WORK}/by-person/{ID}.jsonl` (every observation about them, oldest first, including
> relationships and shared events from anyone's side). Ignore their current working notes. Write
> `{WORK}/working/people/{ID}/profile.md` (and topic notes under the same folder when details don't fit the
> profile), per NOTE FORMAT, following the DREAM RULES and the NOTE SHAPE, weighting by RECENCY × RECURRENCE.
> Working profile ≤ 3,000 characters. Reply with one line: `{ID}: re-grounded from <n> observations`.

4. Then one subagent for the circles in `by-circle/` touched in those chunks and one for the group
   (`by-person/group.jsonl`), same instructions with their working files and formats.

## Step 4: final build

Run `memory observations` first (fresh by-person/, by-circle/, cast.md). The final tree goes in
`work/final/` in the import layout (NOTE FORMAT, CIRCLE FORMAT, FINAL MANIFEST).

### 4a. Circles

List `work/by-circle/*.jsonl` and `work/working/circles/*.md`; one subagent per slug:

> Write the final note of circle `{SLUG}`. Read `{EXPORT}/people.json`, `{WORK}/cast.md`,
> `{WORK}/by-circle/{SLUG}.jsonl` (its observations, oldest first), `{WORK}/working/circles/{SLUG}.md` when it
> exists, and the by-person logs of its members for observations about the shared thing. For the key and
> contested points (who is in it and since when, how it started, anything the observations disagree on),
> read the cited chunk lines ±5 lines in `{EXPORT}/chunks/` (at most 10 passages) and follow what was
> actually said. Write `{WORK}/final/circles/{SLUG}.md` per CIRCLE FORMAT, following the DREAM RULES: dated
> membership (people who left keep their entry with `until`), Now / Earlier, the origin story with dates.
> A thing only one person does is not a circle: then write nothing and reply `{SLUG}: not a circle`.
> Otherwise reply `{SLUG}: <members> members`.

Record each slug in `final.circles` (also the "not a circle" ones).

### 4b. People

For each owner in `work/by-person/index.json` → `people` (skip people with fewer than 3 observations;
their journal rows will reach the dream anyway):

- **Long logs** (`tokens` > 60,000): build eras first. From the index's `years` (estimated tokens per year),
  group consecutive years into eras of at most ~40,000 tokens. For each era not in `final.eras`
  (`<id>:<from>_<to>`), a subagent:

  > Summarize person `{ID}`'s observations dated {FROM}–{TO} from `{WORK}/by-person/{ID}.jsonl` (read only
  > the lines whose `date` falls in that range) into `{WORK}/eras/{ID}/{FROM}_{TO}.md` (≤ 6,000 characters):
  > dated, keeping every span, recurrence and relationship, every contradiction and correction, and the
  > chunk/line evidence of the key points in brackets. No interpretation beyond the observations. Reply
  > with one line.

- Then one subagent per person:

> Write the final notes of person `{ID}` (their entry in people.json has this `id`). Read `{EXPORT}/people.json`,
> `{WORK}/cast.md` (everyone, so relationships read consistently), the final circles they are in
> (`{WORK}/final/circles/*.md` whose front matter lists `{ID}`), and their full observation log
> `{WORK}/by-person/{ID}.jsonl` (oldest first; it includes every relationship and shared event involving
> them, from either side) [long logs: instead the era summaries in `{WORK}/eras/{ID}/` in date order, plus
> the raw observations of the most recent era and every `"kind": "relationship"` line].
> For the key and contested items (contradictions, low confidence, anything about to become a Now or Traits
> fact), read the cited chunk lines ±5 lines in `{EXPORT}/chunks/` (at most 15 passages) and follow what was
> actually said. Write `{WORK}/final/people/{ID}/profile.md` and any topic notes
> (`{WORK}/final/people/{ID}/<topic>.md`) per NOTE FORMAT, NOTE SHAPE, DREAM RULES and LIMITS. The profile's
> "Circles & people" section lists their circles by title and their closest relationships by name. Reply
> with one line: `{ID}: profile + <n> topics`.

Record each id in `final.people`.

### 4c. The group

> Write the group's final notes. Read `{EXPORT}/people.json`, `{WORK}/cast.md`, `{WORK}/by-person/group.jsonl`,
> every `{WORK}/final/people/*/profile.md` and `{WORK}/final/circles/*.md` (front matter and first
> paragraph). Write `{WORK}/final/group/<topic>.md` per NOTE FORMAT (at most 8 topics), typically: `vibe`
> (how the group talks and what it's like, ≤ 2,000 characters: the bot reads it every turn), `lore`
> (server-wide legendary moments, dated), `running-jokes` (each with where and when it started), and
> `people` (who's who and who's close to whom: a relationship map by name). Server-wide things only: a
> thing among specific people is a circle. Reply with one line.

Set `final.group` to true.

## Step 5: critic

> You are the critic of a memory bootstrap. Read `{EXPORT}/people.json` and `{WORK}/cast.md`. Pick the 5
> people with the most observations (`{WORK}/by-person/index.json`) plus any 3 others. For each, compare
> `{WORK}/final/people/<id>/profile.md` against their log `{WORK}/by-person/<id>.jsonl`: every Now and
> Traits claim must be supported, dated and weighted by recency × recurrence; nothing important missing;
> nothing contradicted by a later observation. Pull the cited chunk lines (±5) for anything doubtful and
> follow what was actually said. Then cross-check relationships between ALL final profiles and circles (A
> says best friends with B, B's says they fell out → reconcile from both logs and the passages; circle
> memberships agree with the profiles). Fix what is wrong directly in the files under `{WORK}/final/`, and
> write `{WORK}/critic/report.md`: what you checked, what you changed and why. Reply with one line:
> `critic: <checked> profiles, <fixed> fixes`.

Set `critic` to true.

## Step 6: check and hand over

1. Write `work/final/manifest.json` (FINAL MANIFEST), copying `journal_high_water` and `exported_at` from
   `export/manifest.json`.
2. Run `memory import --check data/memory-bootstrap/work/final --people data/memory-bootstrap/export/people.json`.
   It runs the bot's own import loader against a scratch store. For problems, give the exact list to a fixer
   subagent ("fix these problems in these files, change nothing else, reply with one line") and check again.
   When it passes, set `check` to true.
3. Hand over to the owner, in these words or close: the tree in `data/memory-bootstrap/work/final/` passed
   the check; to load it, copy its contents into the bot's data volume as `data/memory-import/`, so that
   `manifest.json` sits right in that folder (for example
   `docker cp data/memory-bootstrap/work/final/. frigidaire-bot:/app/data/memory-import/` and
   `docker exec frigidaire-bot chown -R node:node /app/data/memory-import`) and restart the bot. At startup
   the bot validates it again, loads it as the notes' first version, moves it to
   `data/memory-import/imported-<timestamp>/` and posts one line in the report channel; a tree with any
   problem loads nothing and stays in place (the log says why). The export and the work folder are private
   chat: delete them once the import is done.

## Reference

### OBSERVATION FORMAT

One JSON object per line in `observations.jsonl`:

```json
{"people": ["100000000000000001", "100000000000000002"], "category": "fact", "kind": "relationship", "content": "Remi and Dale have been best friends since high school; Dale calls Remi 'the baker'.", "date": "2019-03-02", "confidence": 0.9, "evidence": [{"chunk": "0007", "lines": [412, 418]}], "quote": "we've been stuck with each other since grade 9", "circle": "remi-and-dale"}
{"people": ["group"], "category": "vibe", "kind": "joke", "content": "Running joke 'the calendar incident': every event landed on a Tuesday after Dale edited the group calendar (origin 2019-03).", "date": "2019-03-05", "evidence": [{"chunk": "0007", "lines": [980, 991]}]}
```

- `people`: the main ids involved (people.json `id`s): one person, several for a relationship or a shared
  event, or `["group"]` for something server-wide.
- `category`: `fact` | `preference` | `personality` | `event` | `vibe`.
- `kind`: `trait` | `fact` | `event` | `joke` | `relationship` | `history`.
- `content`: one self-contained statement (≤ 600 characters), in English, naming people by their current
  name (the people.json key without any " (@handle)" or " (2)" suffix), never by id.
- `date`: when it was said or happened, `YYYY-MM-DD` or `YYYY-MM`.
- `confidence`: optional, 0–1, when it is less than sure (a joke that might be serious, a third-party claim).
- `evidence`: at least one `{"chunk": "NNNN", "lines": [from, to]}` in this chunk's NEW part.
- `quote`: optional, a short verbatim excerpt (≤ 300 characters) of the key line.
- `circle`: optional, the slug of the circle it belongs to.

### KNOWLEDGE RULES (what to observe)

1. Durable knowledge plus notable history worth remembering years later: jobs, studies, where people
   live and moves, relationships (partners, family, friendships, rivalries), pets, games and hobbies,
   skills, goals, strong likes and dislikes, how they talk and joke, long-running habits, legendary
   moments, running jokes and where they started, group traditions.
2. Never the conversation itself: that someone asked, answered, joined, reacted or shared something is
   transcription. Record what a message REVEALS about a person, never what it DID.
3. Every observation is dated, and its evidence cites the lines.
4. First-hand only: something about a person comes from what they said or did, or from others in a way the
   person didn't dispute; a third party's claim is recorded as that person's claim, with a lower confidence.
5. A self-correction ("no, I quit Valorant in August") beats anything said before about it.
6. No censoring and no paraphrasing away of what people are like: record them as they are, edgy humor
   included. No moralizing, no softening.
7. No speculation beyond what was said. Nothing from the ALREADY COVERED lead-in.
8. Real names and nicknames are observations too (`kind: "fact"`), since people.json may not know them all.
9. English, whatever language the chat was in (quotes stay verbatim).

### DREAM RULES (how notes are written, working and final)

1. Merge new facts into what is known; one fact lives in one place.
2. Contradictions: newer wins; a self-correction beats anything; a third-party claim is weighed, never
   blindly applied (no quiet rewriting of a friend's profile as a joke).
3. **Recency × recurrence decide weight.** Something seen across many years is core; something seen once
   years ago and never since is an Earlier footnote written as history ("Back in 2017, …"). When recent
   evidence contradicts old, the recent wins and the old moves to Earlier.
4. Keep dates and spans in the text: "since 2024", "as of Sept 2026", "2019–2026, constant", "most weeks".
   Every consolidated fact carries its span (first seen – last seen) and how often it recurred.
5. Move superseded or long-unseen facts to a short Earlier section instead of deleting history.
6. Details go to topic notes (`games`, `work`, `school`, `relationships`, `history`, `running-jokes`, …);
   the profile stays who they are.
7. Circles: create one when observations show a recurring shared thing among specific people (an interest
   group, a sub-group, roommates, or a pair's history: best friends since school, a long rivalry); keep its
   membership dated; merge duplicates. The group notes are only for truly server-wide lore.
8. No censoring or paraphrasing away of what people are like; no speculation beyond the observations and
   their passages; English.

### NOTE SHAPE

A profile:

```markdown
---
title: Remi
---
Remi, the group's night owl turned early baker.

## Now
Runs day shifts at a bakery (since 2026-08; nights for years before). Plays Deadlock most evenings (since
2026-08, most weeks). Organizes the Friday drafts.

## Traits
Dry humor; answers questions with questions (2019–2026, constant). Posts bread photos at 6 a.m.

## Circles & people
- The MTG crew: runs Friday drafts (since 2021).
- Dale: best friend since high school; a running rivalry over Mario Kart.

## Earlier
- Played Valorant 2024–2026, quit in August 2026 (his own correction).
- Back in 2017 played Overwatch nightly (seen once since).
```

- The first line: who they are, in one sentence. **Now**: who they are these days (~200–400 words at
  most). **Traits**: how they talk and joke, long-running habits. **Circles & people**: their circles by
  title and their closest relationships by name. **Earlier**: dated footnotes.
- Topic notes and circles use **Now** and **Earlier** only.

### NOTE FORMAT (working and final notes)

- A person: `people/<main id>/profile.md` (required) and `people/<main id>/<topic>.md`.
- The group: `group/<topic>.md`.
- File names are lowercase slugs: letters, digits, single hyphens, ≤ 32 characters, then `.md`.
- Each file starts with front matter, then markdown:
  ```markdown
  ---
  title: Games
  ---
  ## Now
  …
  ```
  `title` is one line, ≤ 80 characters (a person's profile title is their current name). No other keys.

### CIRCLE FORMAT

`circles/<slug>.md`:

```markdown
---
title: The MTG crew
aliases: ["the drafters", "magic nights"]
members: [{"id": "100000000000000001", "since": "2021", "role": "organizer"}, {"id": "100000000000000003", "since": "2024-02"}, {"id": "100000000000000002", "since": "2021", "until": "2023-02"}]
---
## Now
Friday drafts at the game store (since 2021, most weeks).

## Earlier
- Started as a kitchen-table cube draft at Remi's in 2021.
```

- `members`: 2–30 main ids, EVERY member ever (current and former), each with optional `since`/`until`
  (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`; no `until` = still a member) and an optional short `role`. The values
  after `aliases:` and `members:` are JSON on one line.
- `aliases`: up to 8 other names the group uses for it (≤ 40 characters each), or leave the key out.

### LIMITS (the import refuses anything past them)

- Profile ≤ 4,000 characters; any other topic ≤ 8,000; a circle ≤ 6,000.
- ≤ 10 topics per person (the profile included); ≤ 8 group topics.
- ≤ 60 circles in all; nobody currently in more than 12; 2–30 members each.
- Titles: one line, ≤ 80 characters. Slugs: as above.
- Markdown only. Never: Discord mentions (`<@…>`, `<#…>`), custom emoji or timestamp syntax, `@everyone` /
  `@here`, HTML tags, or any 15–21-digit number (a Discord id) in a title or text. Describe emojis in words.
  Ids belong only in folder names and circle `members`.
- Every person folder and circle member must be a main id from people.json (never a linked account).

### FINAL MANIFEST

`final/manifest.json`:

```json
{
  "format": "frigidaire-notes",
  "version": 1,
  "journal_high_water": 1234,
  "source": "claude-code playbook",
  "exported_at": "2026-09-26T21:00:00.000Z",
  "built_at": "2026-09-28T10:00:00.000Z"
}
```

`journal_high_water` is copied from the export's manifest: the import moves the imported people's dream
watermarks there, so the nightly dream only folds in journal rows written after the export.
