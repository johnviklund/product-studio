# Product Studio TODO

This is the human's workflow-managed intake scratchpad, not a roadmap. Use `workflow todo`
to capture, shape, merge, update, or archive future work; `ROADMAP.md` owns the initial
delivery phases.

## Active Initiatives

## Small UI Changes

- **Replace the free-text tags box with a token/chip picker (capture panel + editor).**
  Tags are currently entered as a comma-separated text field (`parseTags` in
  `components/kanban/capture-panel.tsx`, `tagsFromInput` in `capture-editor.tsx`) that splits on
  commas but does not dedupe. The server rejects case-insensitive duplicate tags (`tagsSchema`
  in `src/domain/work-item.ts`), and that rejection surfaces only as a generic
  `400 "Invalid request"` (review P3 #1, 2026-07-21) with no hint that tags are the cause. Move
  to an explicit token/chip input (ideally suggesting existing tags) that dedupes
  case-insensitively on the client and shows a clear inline message — removing the last spot
  where free text is parsed into structure. Small and isolated; not urgent.

## Open Questions
