# Memory v2: per-person notes, circles, conversation-end capture, nightly dreaming

This is the design of the bot's long-term memory from memory v2 on. It replaces the "atomic facts + retrieval
injection" architecture described in AGENTS.md ("Long-term memory & learning"). Names in examples are the
test suite's fictional cast (Remi, Dale, Nova); ids are placeholders.

> **Status.** The foundation is in (data model, chat-time use, tools, config, the interfaces below). The
> conversation-end capture trigger, the nightly dream, the viewer/owner edit and the bootstrap tooling are
> being built on top of it; see [Code map](#code-map).

## Why

Memory v1 is a few hundred one-sentence rows (the `memories` table) filled by a 30-minute learner and
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
| `note_versions` | Every version ever written (the current one included): title, content, aliases, a circle's membership snapshot, active, when, who, and the reason (the dream's change summary, the owner's instruction, "undo of v3", "merged into mtg"). Undo restores the previous version as a new version, membership included. |
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

After the people, a group pass: journal rows about the server (no person) plus the night's person change
summaries become the group notes (and any circle). It runs only when the group has new rows: person changes
alone don't wake the strong model.

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

Years of history sit in the message archive (archive.db). Two routes turn it into first notes.

### 1. Export

A CLI (runnable in the prod container and locally) writes `data/memory-bootstrap/export/`:
- one compact transcript per month (`YYYY-MM.md`): `## YYYY-MM-DD (Weekday)` per day, `### #channel` per
  channel run, then `HH:MM Name: text` lines. Consecutive messages by the same author within a few minutes are
  merged onto one line joined by ` / `. Names are the member's current display name (unique per export);
  `people.json` maps each name to the main id, every other name and linked accounts, so ids never appear per
  line. Transcripts inline, attachments `[file: name]`, embeds `[link: title]`, replies `(↩ Name)`; relays
  attributed; other bots excluded; `ARCHIVE_IGNORE_CHANNELS` respected; the bot's own lines kept, prefixed
  `bot:` and truncated. Framing stays under ~15% of the text's own tokens.
- `chunks/NNNN.md` sized by tokens (`--chunk-tokens`, default ~80k), each boundary at the longest quiet gap
  near the target size (never mid-conversation), each opening with the previous ~2k tokens under an
  `## ALREADY COVERED — context only, do not extract` header. Chunk files have stable line numbers.
- `manifest.json`: months, message/character/token counts per month and in total, every chunk (date range,
  messages, tokens), the export time and the journal's highest `journal_seq` at export.

### 2. The playbook (a Claude Code skill in the repo)

`.claude/skills/memory-bootstrap/SKILL.md` tells a Claude Code agent how to run the bootstrap. An orchestrator
that stays lean (it reads only the manifest and `progress.json`, launches one fresh subagent per step and
records each finished step) runs:
- **Sequential scan**, chunk by chunk in date order, one fresh subagent each. Input: the chunk, `people.json`
  and the current working notes (every profile and circle, capped). It appends dated observations to
  `observations/NNNN.jsonl` (`people`: the main ids involved, one or several, or `["group"]`; `category`;
  `content`; `date`; `kind` (`trait` \| `fact` \| `event` \| `joke` \| `relationship` \| `history`);
  optional `confidence`; `evidence: [{chunk, lines: [from, to]}]` and a short `quote`), interpreting
  references with what the working notes know (a callback to an old joke is recorded as that joke, with its
  origin), and updates the working notes it touched (a small dream). Nothing is extracted from the "already
  covered" lead-in. The observation log is append-only; the working notes are only an interpretation aid.
- **Re-grounding** every ~10 chunks: per person with new observations, their working notes are rebuilt from
  their FULL observation log (not from the previous notes), so re-summarizing drift is reset.
- **Final build**: per person, the final notes (front matter: title) from their full observation log sorted by
  date, plus every relationship/shared-event observation involving them (from either side), plus a cast sheet
  (the first paragraph of everyone's working profile), weighted by recency × recurrence into the Now / Traits
  / Circles & people / Earlier shape; hierarchical (era summaries first) when a log exceeds ~60k tokens.
  Circles are built from the shared observations and filed under every member involved; then the group notes
  (lore, running jokes with their origin, who's close to whom).
- **Check**: a critic subagent pulls the cited passages (± context) for key and contested items and
  reconciles against the real messages, and cross-checks relationships between profiles (A says best friends
  with B, B's says they fell out → reconcile from the log); then `import --check` validates the tree.
- `progress.json` records every step; a scan step is atomic (its observations and working-note updates are
  committed together by renaming temp files), so an interrupted run resumes exactly where it stopped.

Privacy note: this route runs on the owner's own Claude subscription. A consumer Claude plan is not
zero-data-retention; that is the owner's informed choice for this one-off import, documented as such. The
built-in route below stays ZDR.

### 3. Import

At startup, a `data/memory-import/` folder holding a notes tree and a manifest is validated (known ids, sizes,
slugs, markdown, circle membership), loaded as note versions (`updated_by = 'bootstrap'`), the dream
watermarks set to the manifest's journal high-water mark, and the folder renamed to
`data/memory-import/imported-<timestamp>/`, with a log line and a report-channel line. A tree that fails
validation is left in place with a clear error, nothing loaded. A `check` CLI mode validates without loading.

### 4. Built-in bootstrap (OpenRouter, ZDR)

`yarn memory:bootstrap --dry-run` counts the archive and prints estimated tokens and cost from the model
catalog's prices for `MEMORY_BOOTSTRAP_MODEL` (default the dream model); `--run` feeds the history through the
capture extractor (journal rows with source `bootstrap`, backdated `first_seen_at`, evidence ids), resumably,
then triggers a dream for everyone. Tag `memory_bootstrap`.

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

`LEARNING_INTERVAL_MS` still parses (the original interval trigger). Startup summary tokens:
`dream=on(model:…,hour:4,max:20,report:on|off|no-channel[,edit:…][,bootstrap:…])`,
`learning=idle:20m,span:2h,min:5,…`, `owners=app|N`.

## Cost visibility

Usage tags `memory_capture`, `memory_dream`, `memory_edit`, `memory_bootstrap` land in the weekly digest's
Spend section and `query_costs` automatically; the dream's report line carries the night's cost.

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
| `src/ai/memory/notes/dreamer.ts` | the dream and edit contract; `previewChanges()`, `applyEdit()` |
| `src/ai/captureTrigger.ts` | when the learner reads a channel (`CaptureTrigger`, `ConversationEndTrigger`) |
| `src/ai/capture/conversation.ts` | reading a whole conversation (paging, the cap) and splitting it into parts with lead-ins |
| `src/ai/capture/citations.ts` | resolving an observation's cited lines, quote and related members |
| `src/ai/capture/knowledge.ts` | what the extractor already knows about the people in a conversation |
| `src/ai/tools/notes.ts` | `list_notes`, `read_note`, `search_notes`, `record_correction` |
| `src/commands/whatDoesFridgeKnow.ts`, `src/commands/notesViewer.ts` | the viewer: the command, its custom ids and rendering |
| `src/commands/notesViewerActions.ts`, `src/commands/noteDiff.ts` | the viewer's clicks: paging, the owner's Edit (draft, diff preview, Confirm/Cancel) and Undo |
| `src/events/notesViewerInteraction.ts` | routes the viewer's buttons, menu and modal |
| `src/botOwner.ts` | the owner resolution |

Tests use a fictional cast and placeholder snowflakes; everything is hermetic (in-memory stores, injected
clocks and clients).
