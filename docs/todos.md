# Todo widget grounding

A note-local task list stored in a `kanso-todos` fence, not a vault-wide task
index or Markdown-checkbox synchronizer. Shared infrastructure rules are in
[AGENTS.md](../AGENTS.md).

## Code map and data flow

`src/todos/model.ts` validates collections and formats local dates;
`persistence.ts` owns typed mutations and edit conflicts; `widget.ts` renders
through an injected `TodoWidgetHost`. `src/main.ts` supplies note I/O, pane state,
keyboard scopes, the fuzzy source-note picker and navigation. `styles.css` contains scoped
todo layout, narrow-pane/touch handling and reveal animations.

UI action -> host save -> locate the latest fence -> mutate/revalidate YAML ->
replace the fence body -> refresh. There is no network or metadata service.
Reading an empty template must not write initialization data.

## Data contract

Root fields: `version: 2`, optional `id` and `title`, and optional `todos`. The default
display title is `Tasks`; custom titles are edited in YAML, not through a title
editor. An empty fence represents `{version: 2, title: "Tasks", todos: []}`.
Omitting `todos` also represents an empty list; reading does not insert the field
into the YAML document. The first mutation creates it. Explicit non-list values,
including `todos:` or `todos: null`, remain invalid.
Missing IDs are assigned on mutation (`kt_` for blocks, `td_` for tasks).

| Task field | Meaning |
| --- | --- |
| `id` | Stable action identity; optional until initialized. |
| `title` | Required nonempty plain text. |
| `status` | Required `todo`, `doing` or `completed`; controls badges and grouping. |
| `priority` | Optional `P0`, `P1` or `P2`. |
| `created_at` | Required UTC ISO string. |
| `completed_at` | Set on completion, removed on reopening. |
| `due_date` | Optional quoted `YYYY-MM-DD`, a local calendar date, not a UTC instant. |
| `source_note` | Optional Obsidian note link/path; reference only, never a write/sync target. |
| `rollover` | Optional mapping with `previous` and/or `next` task-entry references; see below. |

Version 2 is a status-only schema: legacy version 1 blocks with
`completed: true/false` are invalid and must be migrated to `status`. Adds
prepend. Completing/reopening changes fields in place, **never YAML order**. The
view filters into active (`todo`/`doing`) and completed groups while retaining
order within each group; it does not sort by status, priority or due date.
Clearing an optional editable field removes only that field; unknown fields
remain intact.

`parseLocalDate` checks real calendar dates using local noon. Labels are Today,
Tomorrow or day/month, with past dates marked overdue. Preserve local-date
semantics rather than converting through UTC.

## Interaction and state decisions

- Expanded lists show active rows; completed rows are not mounted until their
  section is expanded. An all-completed list shows "All done".
- The checkbox exclusively controls completion: checking sets `status: completed`
  and `completed_at`; unchecking always resets to `todo` and removes the timestamp.
  The adjacent all-caps badge cycles active tasks between `todo` and `doing`.
  A same-sized neutral badge displays optional priority; clicking it cycles
  `P0` -> `P1` -> `P2` -> `P0`, while Edit can clear priority.
- Collapse mounts only the heading and total count (including completed tasks).
  Clicking the collapsed header expands it. **Both collapse and completed-section
  expansion are transient pane state**; never persist
  them to plugin data or YAML.
- Capture and edit share one form: a borderless title input plus Priority, Due
  and Source note property chips. Chips open Obsidian menus (due presets plus a
  hidden native date picker) or the `pickNote()` fuzzy modal; they never save on
  their own. Enter on the title (or Mod/Ctrl+Enter anywhere) submits; Escape
  cancels; Add/Save stays disabled until the title is non-empty. New tasks
  always start as `todo`; invalid/failed saves retain input.
- One edit draft per widget replaces that row's content in place (`is-editing`).
  Status remains controlled by the task pill and completion checkbox. Save
  compares the editable fields and current status against the original values.
  `TodoConflictError` retains the draft and updates its expected baseline:
  a second explicit save overwrites the newer fields, while Cancel abandons it.
- Draft/capture/focus state belongs to the pane host so refreshes and write-triggered
  remounts do not discard it. Initialize legacy IDs before acting and migrate
  draft keys from temporary indices. Delete is immediate.
- Source-note inputs suggest Markdown paths without `.md`; they also accept typed
  values. Source-note chips show only the note name, without folders or `.md`,
  while retaining the original link for navigation. Navigation strips outer
  `[[...]]` and resolves relative to the widget's note through Obsidian's metadata
  cache. Missing targets show an error; no note is created automatically.

## Agent-authored rollover contract

Rollover is authored by an agent through offline note edits while Obsidian is
inactive. There is **no move button, command/API, automatic rollover, transaction
recovery, or undo**. The agent owns destination/date policy, reciprocal links,
duplicate prevention, and repair. The plugin validates local YAML, renders the
relationships, and navigates to exact entries. It does not audit other notes or
rewrite history on completion.

Keep `version: 2`. Each entry in a chain has a distinct stable task ID, and each
participating block must already have a stable block ID. `rollover` must contain
at least one of `previous` and `next`; ordinary tasks omit it entirely. Each
reference contains:

| Reference field | Meaning |
| --- | --- |
| `note` | Exact vault-relative Markdown path, including `.md`, e.g. `Daily/2026-10-25.md`. No wikilink syntax, leading slash, backslashes, or `.`/`..` path segments. |
| `block_id` | Stable ID of the target `kanso-todos` fence. |
| `todo_id` | Stable ID of the target task entry, not a shared chain ID. |
| `date` | Quoted `YYYY-MM-DD` calendar date of the referenced entry, used for display. Never inferred from the filename, deadline, creation timestamp, or today's date. |

For a chain from 24 to 25 to 28 October, the **middle entry** might be:

```yaml
version: 2
id: kt_oct25
todos:
  - id: td_oct25
    title: Review proposal
    status: doing
    priority: P1
    created_at: "2026-10-24T08:00:00Z"
    due_date: "2026-10-24"
    rollover:
      previous:
        note: Daily/2026-10-24.md
        block_id: kt_oct24
        todo_id: td_oct24
        date: "2026-10-24"
      next:
        note: Daily/2026-10-28.md
        block_id: kt_oct28
        todo_id: td_oct28
        date: "2026-10-28"
```

The 24 October entry has only `next` pointing to the 25 October entry. The
28 October entry has only `previous` pointing to the 25 October entry. A later
move adds `next` to the formerly latest entry without replacing its `previous`
or changing earlier links. Copy task content, TODO/DOING status, priority,
deadline, `source_note`, original `created_at`, and unrelated fields to the new
entry, assigning a new task ID. Moving is not completing; do not add a completion
timestamp. Original-creation references and a creation-details surface are
out of scope; `source_note` remains an unrelated user reference.

- `next` makes an entry historical: muted title (not struck through), a
  non-interactive `↦`, no TODO/DOING badge, and non-interactive priority. All
  widget mutations—including stale edit/completion/delete requests—are refused.
  Historical rows stay in the main list in YAML order, never in Completed.
- Outgoing-only rows show `Moved → [date]`; incoming-only rows show a small
  `corner-down-left` SVG return arrow followed by the date (not a font glyph
  or emoji); middle rows show a joined `From [date]` / `Moved → [date]` pill
  with separate links. Incoming halves use restrained theme-adapted lavender;
  outgoing halves are neutral. Due dates and overdue styling remain unchanged.
- Incoming-only entries retain ordinary edit, status, completion, reopen, and
  deletion behavior. Completing or deleting them changes only that entry;
  deletion may leave a broken predecessor link for the agent to repair.
- Malformed references, missing local block/task IDs, self-references, identical
  previous/next task IDs, and completed entries with `next` are invalid. Dates
  are validated as calendar dates, but ordering and daily-note policy belong to
  the agent. Reciprocal links and full-chain consistency are not checked.
- Links read the current note/editor content, locate the unique block and task
  IDs, and reveal/focus the row, expanding its widget and Completed section when
  needed. Source mode navigates to the task's YAML line. Navigation never saves
  or initializes IDs. Missing, renamed, or ambiguous targets report an error;
  there is no title matching, vault-wide fallback, automatic note creation, or
  path repair.

## Regression anchors

`tests/todos-model.test.ts` covers schema, status/priority mutations, AST
preservation, completion timestamps, field conflicts and calendar semantics.
`tests/todos-widget.test.ts` covers startup, badges, collapsed/unmounted sections,
creation, completion/reopen, inline edits, navigation, rollover rows and deletion.
`tests/todos-navigation.test.ts` covers exact task targeting, pane selection,
Source-mode positioning, and missing targets. Run these with
`npm test -- tests/todos-model.test.ts tests/todos-widget.test.ts tests/todos-navigation.test.ts`.
Use live Obsidian checks for native date-input, touch-target and narrow-pane layout;
jsdom does not establish visual correctness.
