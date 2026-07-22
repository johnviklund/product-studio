# Reviewer golden case — dnd-kit KeyboardSensor swallows Enter meant for a custom action

- **Seat:** strict reviewer
- **Date:** 2026-07-21
- **Cycle:** ROADMAP 1.5 (Context panel, valid transitions, and keyboard flow)
- **Caught at:** Phase 4 review, HEAD `54e0b3c`
- **Provenance:** written by the default-executor seat (GPT), caught by the strict-reviewer seat
  (Copilot · Claude Opus 4.8); disposition ultimately **wontfix** — the fix was withdrawn by the
  product owner in the patch cycle (`.workflow/patch_plan.md` Step 1, review re-run at `4dedf19`),
  but the finding itself is a valid, reproducible acceptance-criterion miss and stays a golden
  case for what the reviewer seat must catch.

## Input — diff under review

A card component wants `Enter` to open a detail panel while the same element also participates in
`@dnd-kit/core` drag-and-drop via a `KeyboardSensor`.

`components/kanban/board-card.tsx` (`handleKeyDown`, forwards to dnd-kit's own listener first):

```tsx
const { onKeyDown: onDragKeyDown, ...dragListeners } = listeners ?? {};

function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  onDragKeyDown?.(event);
  if (event.defaultPrevented || isDragging || focusTargetRef.current === null) {
    return;
  }
  // ... Arrow Up/Down navigation, Enter -> onOpenDetail(identity) branch below this guard
}
```

`components/kanban/kanban-board.tsx` (sensor registration, default codes):

```tsx
useSensor(KeyboardSensor),
```

No `setActivatorNodeRef` is wired for the card, so `activatorNode.current` is `null` — the
sensor's own target gate is disabled, meaning it does not filter by activator element and will
act on any keydown forwarded to it.

**Spec acceptance criterion under test:** "Enter opens the focused card's detail panel; Arrow
Up/Down navigate; pointer drag-and-drop is unaffected."

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P1** severity, that `@dnd-kit/core`'s `KeyboardSensor` default
`keyboardCodes.start` includes **both `Space` and `Enter`**. Because `handleKeyDown` forwards the
event to dnd-kit's listener *before* checking `event.defaultPrevented`, and dnd-kit's sensor
`preventDefault()`s + starts a keyboard drag on `Enter` (its target gate is inert here since
`activatorNode.current` is `null`), the local guard's `if (event.defaultPrevented) return` then
skips the intended `onOpenDetail` branch entirely. Net effect: pressing Enter silently starts a
drag instead of opening the panel — the headline acceptance criterion is **not met**, even though
`npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` are all green (no DOM/keyboard
test harness exists in this repo, so the miss is invisible to the deterministic gate).

A passing review must also identify the correct fix shape (not necessarily prescribe this exact
diff, but the mechanism): narrow `keyboardCodes.start` on the `KeyboardSensor` to exclude `Enter`
(e.g. `{ start: [KeyboardCode.Space], ... }`), or stop forwarding `Enter` to dnd-kit's listener —
either removes the collision while leaving `Space` as the drag pickup/drop key.

## Grading notes

**A passing answer must contain:**
1. Identification that `Enter` is claimed by *both* the custom `onOpenDetail` handler and dnd-kit's
   `KeyboardSensor` default codes — a genuine key collision, not a generic "add tests" comment.
2. The causal trace: forward-then-check-`defaultPrevented` ordering means dnd-kit's `preventDefault`
   suppresses the local handler, not the reverse.
3. Correctly flags that green typecheck/lint/test/build does **not** prove this acceptance
   criterion — that keyboard-path claims need explicit manual/DOM verification when no harness
   exists, not sign-off from the deterministic gate alone.
4. Names a viable fix mechanism (narrow `keyboardCodes.start`, or stop forwarding the reserved key)
   without requiring the exact prose above.

**Known traps (a failing answer often falls into these):**
- Treating the green deterministic gate (lint/typecheck/test/build) as sufficient evidence that
  keyboard behavior works — it cannot, absent a DOM harness.
- Attributing the swallow to `isDragging` or `focusTargetRef` state instead of the actual cause
  (dnd-kit's sensor consuming the event via `preventDefault` before the local guard runs).
- Suggesting `activatorNode`/`setActivatorNodeRef` as the fix — it changes *which* elements the
  sensor targets, not *which keys* it claims, so it does not resolve this collision.
- Missing that `Space` must remain untouched — the existing screen-reader instructions already
  document `Space` as the pickup/drop key, so a fix that also disables `Space` would regress
  accessibility guidance.

## Disposition (for context, not part of the grading bar)

Withdrawn as wontfix by explicit product-owner direction during the patch cycle ("preserve
pointer drag and drop, but do not add or repair keyboard card controls without explicit
direction") — not because the finding was wrong. The mechanism remains present in the shipped
code (`4dedf19`) and Enter still opens no panel; this is a recorded, accepted scope decision, not
a silently dropped bug.

## Source

- `.workflow/learnings.md` (ROADMAP 1.5 cycle, now routed and deleted)
- `.workflow/review.md` P1 finding, HEAD `54e0b3c` (original) and `4dedf19` (patch-cycle
  re-review, disposition: wontfix/descoped)
- `.workflow/patch_plan.md` Step 1 evidence
