# Kanso Todos contributor notes

Read `docs/todos.md` before changing behavior. Keep `README.md` current when a
user-facing contract changes.

## Architecture

- `src/main.ts` owns Obsidian lifecycle, pane bindings, editor-aware I/O, keyboard
  scopes, navigation, and refresh scheduling.
- `src/todos/model.ts`, `persistence.ts`, and `widget.ts` own schema, YAML mutations,
  and UI. `src/core/` contains only small shared primitives.
- Only top-level, unindented `kanso-todos` fences are editable. Locate by stable
  block ID or exact source/line before initialization; reject ambiguous targets.
- Mutate and revalidate the YAML AST. Preserve unrelated text, unknown fields,
  comments, IDs, order, and line endings where possible.
- Prefer open editor buffers to vault snapshots, reject disagreeing editors,
  serialize writes per note, and use `vault.process` for background writes.
- Keep drafts/focus in pane-local host state across render-child replacements.
  Discard stale refreshes and release menus/key scopes on unload.
- Use `core/dom.ts` helpers, render user content as text, and name controls with
  `aria-labelledby`, not `aria-label` (Obsidian turns that into a tooltip).
- Keep styles widget-scoped, theme-native, and usable on mobile/narrow panes.

## Validation and releases

Run `npm test`, `npm run build`, and `npm run check-release`. Vitest uses jsdom
and the Obsidian shim in `tests/obsidian.ts`; use live checks for native menus,
date pickers, keyboard handling, and layout.

Never edit `main.js`. Keep package, lockfile, manifest, and `versions.json`
metadata aligned. Follow `docs/releasing.md`; mobile support requires real-device
checks, not just jsdom or a narrow desktop pane.

This repository is maintained independently of Kanso UI. Do not alter its
checkout or installed plugin to make changes here. The two plugins cannot be
enabled together in one vault because they register the same fence language.
