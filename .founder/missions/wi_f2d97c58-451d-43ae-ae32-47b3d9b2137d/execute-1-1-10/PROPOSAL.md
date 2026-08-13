# Back Navigation Proposal: Full Work Item to Details Panel

## Entry Point

The user triggers the full work item view from the details panel using the **"View full work item"** button, which appears:

1. At the bottom of the shaping decision checklist preview section (when available)
2. Below the shaping decision loading state

The button is styled as a primary-colored text link and is keyboard accessible.

## Back Navigation Affordance

When the full work item view is active, a **back button** is rendered at the top of the panel, immediately below the header and above the tab navigation.

**Visual design:**
- Text: "Back to details panel" or "Back to shaping decision" (context-aware)
- Icon: Left-pointing arrow (ArrowLeft from lucide-react)
- Styling: Primary blue text, hover state, keyboard focus ring
- Position: Full-width clickable area in a border-bottom section

**Contextual text:**
- "Back to details panel" - when there is no active shaping decision projection
- "Back to shaping decision" - when a shaping decision view was active before entering the full view

## Restored Destination Context

When the user clicks the back button:

1. The `showFullWorkItem` state is set to `false`
2. The detail panel transitions back to its previous view state:
   - If the shaping decision view was active before, it returns to that view
   - If no shaping view was active, it returns to the standard details panel overview
3. The work item remains selected and the panel remains open
4. No panel close/reopen cycle occurs - it's a seamless in-panel view transition
5. The user's position and context within the details panel are preserved

## Implementation Notes

This navigation pattern is already implemented in `components/kanban/detail-panel.tsx`:

- The `showFullWorkItem` boolean state controls the view toggle
- The back button component at lines 8227-8235 handles the return action
- The context-aware button text provides clear affordance about the destination
- The ArrowLeft icon reinforces the navigation direction

The implementation fulfills the acceptance criteria: users can trigger the full view and navigate back to the previously open details panel context without manual intervention.
