# Reviewer golden case — producer/consumer path-representation mismatch defeats the connected agent's core write path

- **Seat:** strict reviewer
- **Date:** 2026-07-26
- **Cycle:** ROADMAP 3.3 (Transport-neutral connected execution and run provenance)
- **Caught at:** Phase 4 review, HEAD `115eb60`
- **Provenance:** written by the default/heavy-executor seats (GPT-5.6), caught by the
  strict-reviewer seat (cross-vendor review, Claude Opus 4.8, at `115eb60`); confirmed **P0**,
  fixed in the patch cycle (commit `995bf74`), re-reviewed clean at the same HEAD.

## Input — diff under review

A capability-envelope system gates a locally spawned ACP agent's operations. Two independent
modules define the two ends of a "workspace write" request:

`src/domain/capability-envelope.ts` (the consumer — validates and matches requests):

```ts
const workspaceRelativePosixPathSchema = z
  .string()
  .refine(isSafeWorkspaceRelativePosixPath, "must be a safe workspace-relative POSIX path");
// isSafeWorkspaceRelativePosixPath rejects any value starting with "/"

const workspaceWriteRequestSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("workspace_write"),
  path: workspaceRelativePosixPathSchema,   // must be RELATIVE
});
const outsideWorkspaceWriteRequestSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("outside_workspace_write"),
  path: absolutePosixPathSchema,            // must be ABSOLUTE
});

// The matcher: any request that fails to parse throws inside canonicalizeCapabilityRequest,
// which the caller catches and treats as an unnormalizable "invalid_request" -> reject.
export function capabilityRequestMatchesEnvelope(request, envelope): boolean {
  const canonicalRequest = canonicalizeCapabilityRequest(request); // throws on bad shape
  switch (canonicalRequest.kind) {
    case "workspace_write": return true;              // unconditional auto-allow
    case "outside_workspace_write": return false;
    // ...
  }
}
```

`src/infrastructure/acp/copilot-runtime-profile.ts` (the producer — classifies a raw ACP
`requestPermission` call into one of the two request kinds):

```ts
function pathFromRawInput(toolCall, workspaceCwd): CanonicalCapabilityRequest | null {
  // ...extract the raw path candidate from toolCall.rawInput / toolCall.locations...
  const path = resolve(workspaceCwd, unique[0]);                 // always ABSOLUTE
  const pathRelativeToWorkspace = relative(workspaceCwd, path);
  const isWithinWorkspace =
    pathRelativeToWorkspace === "" ||
    (!isAbsolute(pathRelativeToWorkspace) &&
      pathRelativeToWorkspace !== ".." &&
      !pathRelativeToWorkspace.startsWith(`..${sep}`));
  return {
    schema_version: 1,
    kind: isWithinWorkspace ? "workspace_write" : "outside_workspace_write",
    path,   // <-- BOTH branches emit the absolute `path`, not the relative one
  };
}
```

The wiring point, in the ACP client's permission handler:

```ts
let normalized = this.profile.normalize_permission(request);   // -> pathFromRawInput(...)
try {
  normalized = canonicalizeCapabilityRequest(normalized);       // re-validates against the schemas above
} catch {
  normalized = null;                                            // -> treated as unnormalizable
}
if (normalized === null) {
  // -> "invalid_request", reject_once
}
```

**Spec/contract guarantee under test:** an exact, in-envelope operation (here, any edit/delete
inside the agent's own workspace) must be auto-approved without founder interruption — this is
the entire point of "permission-mediated local execution." The matcher's `workspace_write` case
returns `true` unconditionally by design (workspace-scoped writes are always allowed; only the
*envelope-restricted* command/URL kinds need an exact-match check).

## Approved output — the finding a passing review must produce

A reviewer must flag, at **P0** severity, that the connected agent can never write a file inside
its own workspace — defeating the feature's central guarantee:

1. `pathFromRawInput`'s in-workspace branch emits the **absolute** resolved `path`, while
   `workspaceWriteRequestSchema` requires a **workspace-relative** path (leading `/` is
   explicitly rejected by `isSafeWorkspaceRelativePosixPath`). The outside-workspace branch is
   fine (`absolutePosixPathSchema` wants an absolute path, and that's what it gets) — only the
   within-workspace case mismatches.
2. Trace the consequence precisely: `canonicalizeCapabilityRequest` calls
   `canonicalCapabilityRequestSchema.parse(...)`, which throws a Zod error on the absolute path
   under the `workspace_write` discriminant. The permission handler's `catch` swallows this and
   sets `normalized = null`, producing outcome `invalid_request` → `reject_once` — **not**
   `missing_permission` and **not** auto-allow. Every in-workspace edit/delete is rejected.
3. State the blast radius: since writing the result file inside the workspace is required for
   *any* connected Execute run to reach `importResult()`, this is not a narrow edge case — it
   silently breaks the feature end to end for its primary operation.
4. Identify why the (green) test suite didn't catch it: the producer's own unit test
   (`copilot-runtime-profile.test.ts`) asserted the **absolute** path as correct output in
   isolation, while the consumer's unit test (`acp-client.test.ts`) supplied its **own** fake
   `normalize_permission` that already emitted a **relative** path — so no test wired the real
   producer through the real consumer for the happy path. Empirically reproducing the throw (not
   just reading the two schemas side by side) is what turns "these look inconsistent" into a
   confirmed, demonstrated P0.
5. Recommend the fix direction: make the producer emit the workspace-relative path for the
   in-workspace branch (keeping `workspaceRelativePosixPathSchema`'s reject-absolute/`..`
   behavior as a real defense-in-depth net against a mis-classified escape), rather than relaxing
   the schema to accept absolute paths — and require a new test that drives the real
   `normalizeCopilotPermission → canonicalizeCapabilityRequest → capabilityRequestMatchesEnvelope`
   chain end to end, not just each half in isolation.

## Grading notes

**A passing answer must contain:**
1. The exact shape mismatch (absolute-emitting producer vs. relative-only consumer schema) and
   that only the `workspace_write` branch is affected, not `outside_workspace_write`.
2. The precise failure path: schema `.parse()` throws → caught → `invalid_request` →
   `reject_once` — not a vague "these two things don't agree."
3. That this breaks the *primary* operation (in-workspace write), not a rare edge case, and that
   it silently defeats the auto-allow guarantee that is the feature's whole point.
4. An explanation of why the green test suite missed it (isolated unit tests with mismatched
   fixtures on each side of the seam) — this is the transferable lesson, not just the bug.
5. A fix direction that preserves the relative-path schema as a safety net rather than loosening
   it to fit the buggy producer.

**Known traps (a failing answer often falls into these):**
- Reading the matcher's `case "workspace_write": return true` in isolation and concluding
  "workspace writes are always allowed, so this is fine" without tracing that the value never
  reaches the matcher — it throws one step earlier during canonicalization.
- Trusting that green tests mean the seam works, without noticing the two test files use
  different path shapes for the same request kind and never call the real producer and real
  consumer in the same test.
- Treating this as a minor validation nit ("tighten the schema" / "add a cast") rather than
  recognizing it silently disables the feature's core autonomous-write guarantee for every run.
- Proposing to fix it by relaxing `workspaceWriteRequestSchema` to accept an absolute path instead
  of fixing the producer — that would work mechanically but deletes a real fail-closed guard
  against a future producer bug that mis-tags an escaping path as `workspace_write`.

## Source

- Review at HEAD `115eb60` and re-review at HEAD `995bf74` (both dispositioned in this cycle's
  review artifact, since deleted per wrap; content preserved above).
- Fix commit: `995bf74` ("Emit workspace-relative path for in-envelope writes").
- Regression coverage: `tests/infrastructure/acp/copilot-runtime-profile.test.ts` — "auto-allows
  a real in-workspace write and denies an escape through the real envelope seam" (drives the real
  `normalizeCopilotPermission → canonicalizeCapabilityRequest → capabilityRequestMatchesEnvelope`
  chain for both the auto-allow and the `../` escape cases).
