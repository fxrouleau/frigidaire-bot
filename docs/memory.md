# Memory v2: per-person notes, circles, conversation-end capture, nightly dreaming

This is the design of the bot's long-term memory from memory v2 on. It replaced the "atomic facts + retrieval
injection" architecture of memory v1; AGENTS.md ("Long-term memory & learning") has the summary. Names in
examples are the test suite's fictional cast (Remi, Dale, Nova, Ozzie); ids are placeholders.

> **Status: built.** Every part below is in: the data model, chat-time use and tools, capture at
> conversation end, the nightly dream (with the weekly group refresh), the viewer with the owner's edit and
> undo, and the bootstrap tooling (export, playbook, startup import, built-in bootstrap). What is deliberately
> left for later is under [Not yet](#not-yet). Code: [Code map](#code-map).

## Why

Memory v1 was a few hundred one-sentence rows (the `memories` table) filled by a 30-minute learner and
injected per turn as a handful of relevance-picked rows. Nothing ever synthesizes them: the bot never sees
"who is this person" as a whole, contradictions ("plays Valorant" / "quit Valorant") and stale facts pile up,
and people are isolated from each other. Memory v2 is what modern agents do: per-person markdown notes (a
profile plus topic notes), shared notes for groups of people ("circles"), consolidated every night by a
"dream" from a raw journal, grounded in the messages they came from, viewable by everyone and editable by the
owner.

The owner's guiding call: good architecture for the foundation matters more than token count.

## Decisions

- **SQLite, not files.** Notes live in memory.db next to the journal. The bot browses them through tools
  (`list_notes`, `read_note`, `search_notes`), never raw SQL.
- **The journal is the source of truth.** The `memories` table stays the raw journal; the dream never
  deletes from it. Notes are derived and can always be regenerated from it.
- **Capture at conversation end**, not every 30 minutes: a cheap model reads each whole conversation.
- **Dream nightly** with a strong model (`MEMORY_DREAM_MODEL`, default `anthropic/claude-opus-5.5`, on
  OpenRouter's zero-data-retention list), only for people (and the group) with new journal rows.
- **Freshness**: a chat turn sees a person's notes plus their journal rows newer than the notes, so nothing
  waits a day to be known.
- **Corrections** are recorded instantly and shown next to the notes until the dream folds them in. A
  correction about yourself is authoritative; one about someone else is a claim the dream weighs (no quiet
  rewriting of a friend's profile as a joke).
- **People aren't isolated.** Circles are notes owned by a set of members (an interest group, a sub-group, or
  a pair with a history). They are never buried: profiles, listings, search and the viewer all surface them.
- **Evidence.** Journal rows keep the key passage they were learned from (message ids and a short verbatim
  quote). The dream rereads the real messages for claims that matter, instead of trusting a chain of
  summaries.
- **Recency × recurrence decide weight.** Something seen across many years is core; something seen once years
  ago is an "Earlier" footnote written as history. When recent evidence contradicts old, the recent wins and
  the old moves to Earlier.
- **Viewing**: everyone can view everyone's notes. **Editing**: only the owner, through a drafted, previewed,
  versioned edit with undo.
- **Cost control**: the strong model runs nightly for changed people and on owner edits only; capture and
  corrections use the cheap model or no model.
- **Hard rules are unchanged** (AGENTS.md): zero data retention on every OpenRouter call with a feature tag;
  no censoring or paraphrasing rule in capture or the dream (the owner's explicit call); fictional cast in the
  public repo; user-facing failures in character; bot posts never ping; model output is untrusted (validate,
  clamp, fail closed); Eastern time; no hardcoded Discord ids.

## Data model (memory.db)

Everything is created idempotently on the existing database.

### The journal: `memories`

The existing table, plus:

| Column | Meaning |
|---|---|
| `journal_seq` | The journal clock. Grows (by trigger) on every insert and on every change of content, subject id, related members or recurrence count, so a dream watermark ("everything up to seq N is in the notes") also catches a re-observation merged into an old row. Existing rows start at their id. Deactivating a row doesn't move it. |
| `said_by` | Who said it (main id): set on `correction` rows. Two people's corrections never merge. |
| `evidence` | JSON `{messageIds, quote}`: the archive message ids the row was learned from (oldest first, ≤ 12: the first three and the newest kept on merges) and a short verbatim quote (≤ 240 chars). Filled by capture, `remember_fact` and `record_correction`. |
| `seen_count` | How often it was observed: 1, plus one per re-observation merged into the row (including duplicates folded by the startup compaction). |
| `first_seen_at`, `last_seen_at` | The observed span (UTC). Usually the write times; a backdated write (the bootstrap reading old history) carries the history's time. |
| `related_user_ids` | JSON array of the other members (main ids) the row is also about. A relationship or shared event is filed under one subject but appears in every involved member's journal and pending dream. |

New category **`correction`**: what is wrong and what is right about someone (`subject_user_id`), with the
speaker in `said_by`. It never expires.

### Notes

| Table | Contents |
|---|---|
| `notes` | One row per note: `scope` (`person` \| `group` \| `circle`), `owner_id` (the person's main id; `''` for the group and circles), `topic` (a slug: `profile`, `games`, `running-jokes`; a circle's unique slug such as `mtg`), `title`, `content` (markdown), `aliases` (JSON, circles only), `version`, `updated_at`, `updated_by` (`dream` \| `edit` \| `bootstrap` \| `import` \| `undo`), `active`. `UNIQUE(scope, owner_id, topic)`. |
| `note_members` | A circle's members, dated: `(note_id, member_id, since, until, role)`. `since`/`until` are partial dates (`2021`, `2021-06`, `2021-06-15`); `until` NULL means still a member. Someone who left the MTG crew in 2023 stays listed with `until = 2023`. |
| `note_versions` | The version history (the current one included): title, content, aliases, a circle's membership snapshot, active, when, who, and the reason (the dream's change summary, the owner's instruction, "undo of v3", "merged into mtg"). Undo restores the previous version as a new version, membership included. After each night it is trimmed to the newest 50 versions per note; bootstrap and owner-edit versions are always kept. |
| `notes_fts` | FTS5 over active notes (title, content, aliases). A plain FTS table kept by triggers on `notes` alone: correct by construction (a delete of a missing row is harmless, unlike the external-content 'delete' command). |
| `dream_state` | Per person and for the group: `journal_watermark` (the highest `journal_seq` folded into the notes), `last_dream_at`, `last_error`. Circles have none: the person and group dreams maintain them. |

Limits, validated on every write: profile ≤ 4,000 chars, other topics ≤ 8,000, circles ≤ 6,000; ≤ 10 topics
per person, ≤ 8 for the group; ≤ 60 active circles, nobody currently in more than 12; 2–30 members per circle;
≤ 8 aliases. Titles are one line ≤ 80 chars. Markdown only: no Discord mention, emoji, timestamp or channel
syntax, no `@everyone`, no HTML, and no Discord id that wasn't in the writer's input. Every write is all or
nothing; a note breaking a rule is refused, never clamped into a different meaning.

### Note shape

```markdown
Remi, the group's night owl.

## Now
Runs day shifts at a bakery (since 2026-08; before that nights for years). Plays Deadlock most evenings
(since 2026-08, most weeks). Organizes Friday drafts.

## Traits
Dry humor; answers questions with questions (2019–2026, constant). Posts bread photos at 6 a.m.

## Circles & people
- The MTG crew: runs Friday drafts (since 2021).
- Remi & Dale: best friends since school; a running rivalry over Mario Kart.

## Earlier
- Played Valorant 2024–2026, quit in August 2026 (his own correction).
- Back in 2017 played Overwatch nightly (seen once since).
```

Every consolidated fact carries its span and how often it recurred. Topic notes and circles follow the same
Now / Earlier split. Chat turns get a note without its Earlier part; Earlier comes up on demand (`read_note`)
or through search. The shape is the dream's job; the store doesn't refuse a free-form note (owner edits and
imports stay flexible), and `noteShapeWarnings()` reports what is off.

### Circles

A circle is a note owned by a set of members:
- an interest or sub-group: the people who play MTG, the Valorant squad, a set of roommates;
- a pair: two people's history (best friends since school, a long-running rivalry). A relationship is a
  circle of two.

Circles are never buried: a member's profile lists their circles (the "Circles & people" section, written by
the dream), `list_notes(person)` and the viewer's topic select list them, `search_notes` matches circle
titles, content and aliases, and `read_note` reads a circle by slug, title or alias. The dream creates a circle
when observations show a recurring shared thing among specific people, updates membership (dated) and
content, and merges duplicates (`merged_from`). The group notes stay for truly server-wide lore.

A person's dream or edit can only change circles that person is or was in.

## Chat-time use

Per turn, the dynamic context carries, for the speaker, the people @-mentioned and the people named in plain
text (≤ 3 each):
- their `profile` without its Earlier part (the speaker's up to 3,000 chars, others' up to 1,500), with a line
  listing their current circles and a hint when Earlier history was left out;
- their journal rows newer than their dream watermark (≤ 10, dated with relative ages);
- their open corrections (always shown, marked with who said them; they win over the notes).

People without notes yet fall back to their plain memories (corrections labelled as claims). Then circles
(≤ 3, up to 1,500 chars each, Earlier left out): the ones the message names (title, slug words or alias, as
whole words), then the ones with at least two current members in the conversation (the speaker, the people
above, the window's recent participants). Everything is shown once per window per note version (noteKeys,
persisted with the window), deduped against what the window already showed.

The static prompt carries a short group section: the group's `vibe` and `lore` notes, Earlier left out, up to
2,500 chars. It changes at most nightly, so the provider's prefix cache survives within a window.

The hybrid journal search stays (old details, exact wording). The persona: when someone says something the bot
knows is wrong or outdated, record it; never argue with a self-correction; a correction about someone else is
that person's claim; no joke rewrites a friend.

Tools:

| Tool | What it does |
|---|---|
| `list_notes({person?})` | A person's topics (size, age) and circles (former ones marked, with spans), plus how many journal rows and corrections are newer than the notes; without a person, everyone with notes, the group's topics and every circle with its current members. |
| `read_note({person?, topic?, circle?})` | A full note, Earlier included: a person's topic (default `profile`, followed by the rows and corrections newer than it), a group topic (`person: "group"`), or a circle by slug, title or alias. |
| `search_notes({query})` | FTS over every note (people, group, circles) with snippets. |
| `record_correction({person, correction})` | Files a `correction` journal row about a member (or the group): the speaker in `said_by`, the triggering message as evidence. Self-corrections are authoritative; anyone else's is a claim. |
| `recall_memories`, `remember_fact`, `forget_memory`, `set_member_info` | Unchanged (remember_fact now keeps its message as evidence). |

Other consumers: the birthday writer gets the profile (Earlier left out) plus the journal rows picked up since
it, dated by first sighting; summaries' WHO'S WHO uses the first lines of each profile.

## Capture

The learner's extraction stays (the 30-day test, event/image categories, no re-saves, subject normalization,
identity updates, attribution through `attributeMessage`, cached voice transcripts, the image cap, the
self-improvement pass). What changes is when it reads a channel, how much it reads, and what it keeps.

**When** (`ConversationEndTrigger`): per channel, once at least `MIN_MESSAGES_FOR_OBSERVATION` new member
messages exist and the channel has been quiet for `CAPTURE_IDLE_MINUTES` (20), or its oldest uncaptured
message is `CAPTURE_MAX_SPAN_MINUTES` (120) old. A 1-minute tick, oldest conversation first;
`LEARNER_IGNORE_CHANNELS` is respected. Activity lives in memory, so at startup every channel captured in the
last two weeks is reported as a possible backlog: each is read once it has been quiet (the learner counts what
it finds against the minimum), and a deploy never strands a conversation. `LEARNING_INTERVAL_MS` still parses
and only drives the old interval trigger, which the bot no longer uses.

**How much**: everything after the channel's watermark, paged past Discord's 100-message fetch, up to 2,000
messages per capture (the rest is reported as a backlog and read once the channel is quiet). A channel never
captured is read back to the start of its last conversation; older history is the bootstrap's job. A
conversation longer than one request (~48k characters of transcript) is split into parts at its longest quiet
gap once a part is at least 60% full, and each later part opens with the end of the previous one (~2k
characters) under `## ALREADY COVERED — context only, do not extract`. The watermark moves after each part, so
a failure part-way neither loses nor repeats anything.

**Evidence and related members**: the transcript's lines are numbered (`#N [time] [Name (id:…)] text`), and each
observation cites `evidence: {lines, quote}` plus, for a relationship or something shared, `related_user_ids`.
All of it is untrusted model output:
- line numbers resolve only to lines the request showed, so the model never types a message id;
- a quote is kept only when it occurs in the cited messages (case, spacing, quote marks and "…" elisions
  tolerated); one found in another shown line cites that line too, and an invented one is dropped;
- related members must be known members (ids or unique names; a side account counts as its main).

A row's first and last seen are when the newest message it cites was posted.

**What it already knows**: for a part's authors and up to 5 members it talks about, their profile without
Earlier (≤ 1,000 chars), their circles, and the journal rows (≤ 12) and open corrections (≤ 5) newer than
their notes; a person without notes yet gets their 25 most recent memories. For the server, its notes
(≤ 1,500 chars together) and the server rows newer than them (without notes, the 25 most recent).

Usage tag `memory_capture` (it replaces `learner`; the self-improvement pass keeps `self_improvement` and runs
once per part). Each capture logs one line:
`capture: channel=… messages=… parts=… observations=… identity_updates=… capped=yes|no`.

## Dreaming

Once per Eastern day at `MEMORY_DREAM_HOUR` (4): the first scheduler tick at or after that hour runs it, a bot
that was down at 4 catches up the same day, never twice a day. `MEMORY_DREAM_ENABLED` switches it off. The
`memoryDream` ClientReady event starts a one-minute check (the first one five minutes after startup, so a
bootstrap import sets its watermarks first). The day is claimed in memory.db's `bot_state`
(`dream:last_night`) before the run starts, so a night that crashes or fails is never retried the same day:
its people are still above their watermarks and wait for the next night.

For each person with journal rows above their watermark (most recently active first, at most
`MEMORY_DREAM_MAX_PEOPLE_PER_NIGHT`, default 20), one call to `MEMORY_DREAM_MODEL` with:
- the rules (below), the person's names (identities), ALL their current notes and circles;
- the new journal rows: dated, category, source and speaker, recurrence count and seen span, related members,
  the quote; corrections say who made them and whether they are authoritative (about themself) or a
  third-party claim to weigh. At most the oldest 300 rows per dream; the rest wait for the next night (the
  watermark moves to the highest row read);
- for claims that are contested, low-confidence or about to become core profile facts, the cited source
  passages (± a few messages around them, read from archive.db by id), at most 8 per dream, picked in this
  order: third-party corrections, self-corrections, traits and preferences, rows seen 3+ times, the rest
  (newest first within each);
- the server's people (every name and id, for circle membership) and today's date.

The answer is JSON:

```json
{
  "notes": [
    { "topic": "profile", "title": "Remi", "content": "## Now\n…" },
    { "topic": "games", "title": "Games", "content": "## Now\n…" }
  ],
  "removed_topics": ["valorant"],
  "circles": [
    {
      "slug": "mtg",
      "title": "The MTG crew",
      "content": "## Now\nFriday drafts at the game store (since 2021, most weeks).",
      "aliases": ["the drafters"],
      "members": [
        { "id": "100000000000000001", "since": "2021", "role": "organizer" },
        { "id": "100000000000000002", "since": "2021", "until": "2023-02" }
      ],
      "merged_from": ["magic-nights"]
    }
  ],
  "removed_circles": [],
  "change_summary": "quit Valorant; runs the MTG drafts"
}
```

It is validated (profile present, sizes, slugs, markdown only, no Discord markup, no ids of other people unless
they were in the input, circle membership shape and dates) and saved all or nothing as new versions
(`updated_by = 'dream'`). A refused answer (invalid JSON, a broken rule, a write the store refuses, an answer
cut off at the length limit) gets one repair round with the errors. The watermark advances only on success
(an answer that changes nothing still advances it); a failure is logged, kept in `dream_state` and retried the
next night. A night stops early after three people failed in a row (an outage). Circles past a 60,000-char
budget are shown as excerpts and may not be rewritten by that call.

Dream rules (the prompt): merge new facts; resolve contradictions (newer wins; a self-correction beats
anything; a third-party claim is weighed, never blindly applied); weigh by recency × recurrence; keep dates
and spans in the text ("since 2024", "as of Sept 2026", "2019–2026, constant") and move superseded or
long-unseen facts to a short Earlier section written as history instead of deleting them; profile = Now
(who they are these days, ~200–400 words) · Traits · Circles & people · Earlier; details go to topic notes;
create, update and merge circles for recurring shared things; no censoring or paraphrasing away of what people
are like; no speculation beyond the journal and its passages; English.

After the people, a group pass: journal rows about the server (no person) plus what changed in the members'
notes since the group's last dream (each person's dated change summaries and the owner's edits, from the
note versions) become the group notes (and any circle). It runs on any night the group has new rows, and
otherwise at least weekly: when its last dream is 7 days old (or it never dreamed) and a person's notes or a
circle changed since, it runs that night with no journal rows (a refresh, about $0.08 a week), so the vibe
and lore keep up with how the members changed.

Report: one report-channel line after a night with changes or failures, e.g.
`🌙 dream · updated 2 profiles (Remi: new job; Dale: quit Valorant) · group: new lore · 1 unchanged · $0.18`
(`MEMORY_DREAM_REPORT`, default on; nothing without a report channel). Tags `memory_dream` (and
`memory_edit` for owner edits, with `MEMORY_EDIT_MODEL`, default the dream model). The dream model only
reasons when asked, so calls send no reasoning field and a `max_tokens` of 16,000 (all answer), with a
10-minute timeout per attempt.

Owner edits (`proposeEdit`) show the model the target's notes (a person's with their circles, the group's with
every circle, or one circle) and the instruction; the draft is checked against the store in a rolled-back
transaction (one repair round when refused), so the preview never shows something Confirm would refuse.

`record_correction` takes at most 15 corrections from one member in a rolling 24 hours (each one can pull a
person into the night's dream); at the cap the bot says so in its own voice.

First night after deploy: everyone's journal is above watermark 0, so the dream builds everyone's first notes
from the existing memories. When a bootstrap import already created notes, the import sets the watermarks so
the dream only processes rows added after it.

## Viewer and owner edits

"What does Fridge know?" (right-click a member) is a private viewer: one ephemeral message, updated in place.
- The person's `profile` first. Its first page also says what the notes don't reflect yet: how many journal
  rows are newer, and the open corrections with who made them.
- A select menu (at most 25 entries): their topics, their circles (current ones, then former ones with their
  spans), and **Raw memories**, the journal list with the ids `forget_memory` takes.
- Prev/Next when a note is longer than one page (~3,800 characters, cut before a heading or at a paragraph).
- A footer with the version, its age and who last changed it (the nightly dream, an owner edit, the bootstrap,
  an import, an undo). A circle also shows its members (dated, with roles) and its other names.

Right-clicking the bot shows the group's notes, then every circle. People without notes see their raw
memories; someone the bot knows nothing about gets one plain line. Everyone can view everyone.

Owner-only buttons (the owner: `BOT_OWNER_USER_IDS`, else the Discord application's owner or its team's
members; a linked side account counts):
- **Edit**: a modal ("What should change?", ≤ 4,000 chars) → the edit model gets the target's notes (a
  person's with their circles) and the instruction → the message becomes a before/after preview, one change
  per page: a line diff (`-` before, `+` after) and, for a circle, its membership and other names before and
  after → **Confirm** saves new versions (`updated_by = 'edit'`, reason = the instruction) / **Cancel**. Edit
  on a circle edits that circle; anywhere else it edits the person's (or the group's) notes.
- **Undo vN**: restores the version before the shown one as a new version (membership included for a circle).
  The button carries the version it was shown for, so a double click never undoes twice.
- Every saved edit and undo also posts one audit line to the report channel (who, whose notes, the versions
  saved, the change summary and the instruction, each capped, one line, `parse: []`), besides the INFO log
  line: e.g. `✏️ notes edit · Ozzie edited Remi's notes: saved profile v6 · moved to Laval · asked: "…"`.

Safety:
- Owner actions are re-checked on every click; a button being there proves nothing. The owner check is bounded
  at 1.5 s so Discord's 3-second window holds: past it, the viewer leaves the owner buttons out, and an owner
  action says to try again.
- A drafted edit is held in memory for 15 minutes (not across restarts). Confirm refuses it when a note it
  covers changed since the draft (the dream, another edit, an undo), and a draft that comes back for another
  target than the one asked about is dropped.
- A component's `custom_id` (≤ 100 chars) carries everything a click needs: the action, the subject (a
  person's main id or the group), the screen (a note id or the raw memories), the page and when it was
  issued. The viewer holds no state between clicks. Its buttons expire 15 minutes after the render that
  issued them (said in character), and paging and the menu use `interaction.update()`.

## Bootstrap

Years of history sit in the message archive (archive.db). Two routes turn it into first notes: the Claude
Code playbook (export → playbook → import) and the built-in bootstrap. Everything runs from one command line,
`src/ai/memory/bootstrap/cli.ts`: `yarn memory <command>` locally, and in the prod container
`docker exec -u node frigidaire-bot node dist/ai/memory/bootstrap/cli.js <command>` (as the `node` user, so
the files it writes in the data volume stay the bot's). It reads `./data`, prints what it did, and never
creates empty databases where the data folder is missing.

| Command | What |
|---|---|
| `export [--out DIR] [--chunk-tokens N] [--lead-in-tokens N]` (`yarn memory:export`) | the archive as compact transcripts (below) |
| `import --check [DIR] [--people FILE]` (`yarn memory:check`) | validates a notes tree with the import's own loader, against a scratch store |
| `observations [WORKDIR] [--people FILE]` | the playbook's bookkeeping: validates the observation log, rebuilds its per-person views and the cast sheet |
| `bootstrap --dry-run \| --run [--from YYYY-MM] [--to YYYY-MM] [--segment-tokens N] [--max-segments N] [--no-dream]` (`yarn memory:bootstrap`) | the built-in bootstrap |

### 1. Export

`export` writes `data/memory-bootstrap/export/` (to a temporary folder first, swapped in when complete):
- `months/YYYY-MM.md`, one compact transcript per month: `## YYYY-MM-DD (Weekday)` per Eastern day,
  `### #channel` per channel run (`#parent › thread` for a thread), then `Name: text` lines. A line starts
  with its `HH:MM` when a conversation (re)starts: after a header, or after 10 quiet minutes. Consecutive
  messages by one author in one channel within 5 minutes share a line, joined by ` / ` (at most 12 messages
  or 700 characters). Names are the member's current display name, made unique within the export (the more
  active keeps the plain name, the other gets their handle or a number); people who left before the bot ever
  saw them are named by the last name they posted with. Mentions become `@Name`, custom emojis `:name:`,
  links their host (`youtube.com/…`), Discord timestamps a date; voice transcripts are inline
  (`[voice: …]`), attachments `[file: name]`, link previews `[link: title]`, stickers, forwards and polls
  too, replies `(↩ Name)`; relays read as their author; deleted messages and `ARCHIVE_IGNORE_CHANNELS` are
  left out; the bot's own lines read `bot:` and are cut to 200 characters. Ids never appear per line.
  Framing (times, names, headers) is ~12% of the text's own tokens on a realistic fictional fixture (a test
  keeps it under 15%).
- `chunks/NNNN.md`, the same transcript cut by tokens (`--chunk-tokens`, default 80k): each boundary at the
  longest quiet gap among the lines that fill the chunk to 75–100% of its target (a busy day is split at its
  own longest gap), each chunk opening with the previous ~2k tokens quoted under
  `## ALREADY COVERED — context only, do not extract`, then `## NEW — extract from here`. The files never
  change once written, so their line numbers are stable evidence.
- `people.json`: each transcript name → `id` (main account), `accounts` (linked side accounts), `real_name`,
  `nicknames`, `other_names` (handles, first-seen names, every name archived with their messages), message
  count and first/last message day, and whether the bot knows them.
- `manifest.json`: per month and in total, messages, characters and estimated tokens (the framing ratio
  too); every chunk (date range, messages, tokens, lead-in tokens); the channels; the export time; and
  `journal_high_water`, the journal's highest `journal_seq` at export.

Token counts are estimates (3.5 ASCII characters per token, one per other character: on the high side).

### 2. The playbook (a Claude Code skill in the repo)

`.claude/skills/memory-bootstrap/SKILL.md` tells a Claude Code agent how to run the bootstrap on the owner's
subscription; it holds every format and rule verbatim. An orchestrator that stays lean (it reads only the
manifest, `progress.json` and the observation index, launches one fresh subagent per step, records each
finished step, and never reads transcripts, observations or notes) runs, in `data/memory-bootstrap/work/`:
- **Sequential scan**, chunk by chunk in date order, one fresh subagent each. Input: the whole chunk (read
  in pages to its last line), `people.json`, and the working notes it needs: the cast sheet, the group notes,
  and the profiles and circles of the people in the chunk (the whole working folder grows with every chunk
  and would not fit one context; working notes are capped: profile 3,000 characters, a topic note 2,000,
  circle 4,000, group topic 5,000). It appends dated observations to `observations/NNNN.jsonl` (always
  written, empty when the chunk has nothing; `people`: the main ids involved, one or several, or
  `["group"]`; `category`; `kind` (`trait` \| `fact` \| `event` \| `joke` \| `relationship` \| `history`);
  `content`; `date`; optional `confidence`; `evidence: [{chunk, lines: [from, to]}]`; an optional `quote`;
  an optional `circle` slug), interpreting references with what the working notes know (a callback to an old
  joke is recorded as that joke, with its origin), and rewrites the working notes it touched (a small dream).
  Nothing is extracted from the lead-in. The log is append-only; the working notes are an interpretation aid.
  A step is atomic: the subagent writes `steps/NNNN.tmp/` and renames it to `steps/NNNN/` as its last
  action; the orchestrator then copies it into place (idempotent) and records it, so an interrupted step is
  simply redone.
- **Re-grounding** every 10 chunks: `observations` rebuilds `by-person/<id>.jsonl` (a person's own
  observations plus every relationship or shared event naming them, from either side), `by-circle/` and
  `cast.md`; then each person the last 10 chunks touched gets their working notes rebuilt from their FULL
  log, not from the previous notes, so re-summarizing drift is reset.
- **Final build**, into `final/` in the import layout: circles first (from `by-circle/` and the working
  circles), then one subagent per person (their full log, the cast sheet so relationships read consistently,
  their circles; hierarchical when a log passes ~60k tokens: era summaries cut from the index's tokens per
  year first), then the group (vibe, lore, running jokes with their origin, who's close to whom). Every
  writer weighs by recency × recurrence into Now / Traits / Circles & people / Earlier and pulls the cited
  chunk lines (± 5) for key and contested items.
- **Critic**: spot-checks profiles against their logs and the cited passages, cross-checks relationships
  and circle memberships between all profiles (A says best friends with B, B's says they fell out →
  reconcile from both logs), fixes the final notes and writes a report.
- **Check**: `memory import --check work/final --people export/people.json`, fixed until it passes; then the
  owner copies `final/` into the bot's data volume as `data/memory-import/` and restarts the bot.

Privacy note: this route runs on the owner's own Claude subscription. A consumer Claude plan is not
zero-data-retention; that is the owner's informed choice for this one-off import, documented as such. The
built-in route below stays ZDR.

### 3. Import

The notes tree (`src/ai/memory/bootstrap/notesTree.ts`):

```
manifest.json         {"format": "frigidaire-notes", "version": 1, "journal_high_water": 1234, …}
people/<main id>/profile.md, people/<main id>/<topic>.md
group/<topic>.md
circles/<slug>.md
```

Each note is markdown under a front matter block: `title:` (plain text), and for a circle `aliases:` and
`members:` as one-line JSON (`[{"id": "…", "since": "2021", "until": "2023-02", "role": "organizer"}]`).
File names are the slugs.

At startup (app.ts, before login, so nothing dreams on the old state meanwhile), a tree in
`data/memory-import/` is read and checked (front matter, slugs, sizes, markdown only, a profile per person,
topic and circle limits; every person and circle member must be a main id the bot knows: identities,
`LINKED_ACCOUNTS`, or an archive author, who then gets an identities row under the last name they posted
with). It then loads in ONE memory.db transaction: every note as a new version (`updated_by = 'bootstrap'`,
reason "bootstrap import"; identical notes write nothing), an imported person's topics the tree doesn't
have removed (versioned, so recoverable), the group's likewise when the tree has a `group/` folder, and every
circle the tree doesn't have when it has a `circles/` folder; then the imported owners' dream watermarks move
to the manifest's `journal_high_water` (never backwards; a mark above the journal's own is refused as an
export of another database). The tree moves to `data/memory-import/imported-<timestamp>/`, the log gets a
summary, and the report channel one line once the bot is ready (`src/events/memoryImportReport.ts`). A tree
with any problem loads nothing: every problem is logged, the report channel gets a one-line refusal, and the
folder stays where it is. `import --check` runs the same loader against a scratch in-memory store (known
people from `--people`, the tree's own `people.json`, or the bot's databases), so a tree that passes it
imports.

### 4. Built-in bootstrap (OpenRouter, ZDR)

`yarn memory:bootstrap --dry-run` cuts the archive into segments (months; a month over `--segment-tokens`,
default 60k, split at its quiet gaps, each with a ~1.5k-token lead-in) and prints the messages, segments,
estimated input and output tokens and cost from the model catalog's per-token prices for
`MEMORY_BOOTSTRAP_MODEL` (default the dream model), plus a rough figure for the dream afterwards.

`--run` reads the segments oldest first, one call each (ZDR, tag `memory_bootstrap`, 8k output tokens, no
reasoning override: the default model only reasons when asked; the dream's 10-minute timeout and one retry,
since a segment's answer takes minutes). The prompt keeps the capture extractor's
rules (the 30-day test, atomic rows, what a message reveals rather than what it did, no censoring) adapted to
history: notable history is worth keeping and dated, and a fact seen again is repeated with the same
wording so it merges into the existing row as a recurrence (seen count, first/last seen widened). The
prompt is the bootstrap's own, but the mechanics are capture's (`src/ai/capture/`): segments are cut by its
splitter (the one that splits a long conversation, weighing lines in tokens here), each segment sees capture's
"already known" section for its people and the server (notes in short, circles, newer journal rows and open
corrections; the newest rows for someone without notes), with each row's seen span and count, the quote is
matched to its line by `citedEvidence()` (kept only when it occurs in the segment), and related members are
resolved by `relatedMembers()`. The answer is untrusted: rows about people outside the export, unknown
categories (only fact, preference, personality and vibe), Discord markup, ids or over-long content are
dropped; an answer that isn't the JSON object asked for (prose, a refusal) fails the segment, and an answer
cut off at the output limit (a dense stretch with more to say than one answer holds) is never parsed: the
segment is read again in two halves at its quietest gap near the middle (each half the same way, down to an
eighth). Rows are saved with source `bootstrap`, `first_seen_at` backdated to the quoted line's time (or the
given date), evidence (the quoted line's message ids and the quote) and the other members involved, once the
whole segment is read (a failure writes nothing of it). Finished
segments are recorded in memory.db (`bot_state` `memory_bootstrap:progress`), so a stopped run resumes at the
next one and a failed segment is retried on the next run; `--from`/`--to` and `--max-segments` make a trial
run. Once the whole archive is read (not after a
range), it dreams everyone with new journal rows until nothing is pending (`runDreamsUntilCaughtUp`): a
night's dream reads at most 300 rows per person, so someone with thousands of history rows gets pass after
pass, then the group the same way. A person whose dream fails is left for the nightly dream, and three
failures in a row stop it, as on a night. It uses the CLI's own stores and never claims the nightly
schedule's day (`--no-dream` skips it; a failure leaves it to the nightly dream).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MEMORY_DREAM_ENABLED` | true | the nightly dream |
| `MEMORY_DREAM_MODEL` | `anthropic/claude-opus-5.5` | the dream (ZDR) |
| `MEMORY_DREAM_HOUR` | 4 | Eastern hour from which the day's dream runs |
| `MEMORY_DREAM_MAX_PEOPLE_PER_NIGHT` | 20 | people dreamed per night, most recently active first |
| `MEMORY_DREAM_REPORT` | true | the report-channel line after a night with changes |
| `MEMORY_EDIT_MODEL` | = dream model | owner edits |
| `MEMORY_BOOTSTRAP_MODEL` | = dream model | the built-in bootstrap |
| `CAPTURE_IDLE_MINUTES` | 20 | a channel's conversation is captured once it has been quiet this long |
| `CAPTURE_MAX_SPAN_MINUTES` | 120 | …or once its oldest uncaptured message is this old |
| `BOT_OWNER_USER_IDS` | empty ⇒ application owner | who may edit and undo notes |

`MIN_MESSAGES_FOR_OBSERVATION` (5) is how many new member messages a conversation needs before it is
captured; `LEARNER_IGNORE_CHANNELS` and `SELF_IMPROVEMENT_ENABLED` keep their meaning. `LEARNING_INTERVAL_MS`
still parses, so an old `.env` never breaks startup, but nothing uses it any more (it only fed the old
interval trigger). Startup summary tokens:
`dream=on(model:…,hour:4,max:20,report:on|off|no-channel[,edit:…][,bootstrap:…])`,
`learning=idle:20m,span:2h,min:5,…`, `owners=app|N`.

## Cost visibility

Usage tags `memory_capture`, `memory_dream`, `memory_edit`, `memory_bootstrap` land in the weekly digest's
Spend section and `query_costs` automatically; the dream's report line carries the night's cost.

## Not yet

Deliberately left out of memory v2, for a later change:
- **Threads and announcement channels aren't captured.** The learner reads text channels only, as before
  memory v2; a conversation in a thread never reaches the journal (the archive and the bootstrap export do
  include threads).
- **No confidence field on journal rows.** The dream's choice of which cited passages to reread is a
  heuristic (contested claims, self-corrections, traits and preferences, rows seen 3+ times, then the rest).
- **Drafted edits live in memory** (15 minutes, at most 20): a restart drops a draft awaiting Confirm.
- **An outage at the dream hour costs that night**: the day is claimed before the run, so nothing retries the
  same day; nothing is lost (watermarks don't move) and the next night catches up.
- **The import refuses a manifest whose `journal_high_water` is above the live journal's** (an export of
  another database); there is no override flag.
- **Token counts are estimates** (export sizes, chunking, the dry run's cost), said as such where printed.
- **Recurrence starts at deploy**: rows written before memory v2 start with `seen_count` 1 and their
  created/updated times as first/last seen.

## Code map

| Path | What |
|---|---|
| `src/ai/memory/memoryStore.ts` | the journal: new columns, the journal clock, recurrence on merges, `relatedUserIdsOf()` |
| `src/ai/memory/evidence.ts` | `JournalEvidence`: normalize, merge, (de)serialize |
| `src/ai/memory/notes/schema.ts` | note/circle shapes, limits, validators, `NotesOutput` + `parseNotesOutput()` (shared by every writer) |
| `src/ai/memory/notes/notesStore.ts` | `NotesStore`: reads, circles, search, all-or-nothing writes, undo, journal queries, dream state |
| `src/ai/memory/notes/sections.ts` | the Now / Traits / Circles & people / Earlier shape |
| `src/ai/memory/notes/context.ts` | how notes render into prompts (chat turn, circles, group section, summaries) |
| `src/ai/memory/notes/passages.ts` | cited passages from archive.db for the dream |
| `src/ai/memory/notes/dreamer.ts` | the writers: `dreamPerson()`, `dreamGroup()` and `planGroupDream()` (new rows or the weekly refresh), `runNightlyDream()`, `runDreamsUntilCaughtUp()` (the bootstrap), `proposeEdit()`, `previewChanges()`, `applyEdit()` |
| `src/ai/memory/notes/dreamPrompts.ts` | the dream, group and edit prompts and how their input is rendered |
| `src/ai/memory/notes/dreamSchedule.ts`, `src/events/memoryDream.ts` | once per Eastern day from `MEMORY_DREAM_HOUR`, the report line, the version trim |
| `src/ai/captureTrigger.ts` | when the learner reads a channel (`CaptureTrigger`, `ConversationEndTrigger`) |
| `src/ai/capture/conversation.ts` | reading a whole conversation (paging, the cap) and splitting it into parts with lead-ins |
| `src/ai/capture/citations.ts` | resolving an observation's cited lines, quote and related members |
| `src/ai/capture/knowledge.ts` | what the extractor already knows about the people in a conversation |
| `src/ai/tools/notes.ts` | `list_notes`, `read_note`, `search_notes`, `record_correction` |
| `src/commands/whatDoesFridgeKnow.ts`, `src/commands/notesViewer.ts` | the viewer: the command, its custom ids and rendering |
| `src/commands/notesViewerActions.ts`, `src/commands/noteDiff.ts` | the viewer's clicks: paging, the owner's Edit (draft, diff preview, Confirm/Cancel) and Undo |
| `src/events/notesViewerInteraction.ts` | routes the viewer's buttons, menu and modal |
| `src/botOwner.ts` | the owner resolution |
| `src/ai/memory/bootstrap/cli.ts`, `commands.ts` | the bootstrap command line (`yarn memory …`, `dist/ai/memory/bootstrap/cli.js`) |
| `src/ai/memory/bootstrap/transcript.ts`, `people.ts`, `chunks.ts`, `export.ts` | compact transcripts, export names, token-sized chunks, the export |
| `src/ai/memory/bootstrap/notesTree.ts`, `importer.ts` | the notes tree format; the startup import and `import --check` |
| `src/ai/memory/bootstrap/observations.ts` | the playbook's observation log: validation, per-person views, cast sheet |
| `src/ai/memory/bootstrap/builtin.ts` | the built-in bootstrap (dry-run estimate, resumable run) |
| `src/events/memoryImportReport.ts` | the import's report-channel line |
| `.claude/skills/memory-bootstrap/SKILL.md` | the Claude Code playbook |

Tests use a fictional cast and placeholder snowflakes; everything is hermetic (in-memory stores, injected
clocks and clients).
