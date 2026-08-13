# Reviewer golden case — a shared union profile must be narrowed to the seat's own policy

- **Seat:** strict reviewer
- **Date:** 2026-08-09
- **Cycle:** ad-hoc connected-runtime enablement debugging at base `bfa402f`
- **Caught at:** live connected shaping, after the green 805-test suite failed to expose a
  model-dependent terminal permission denial
- **Provenance:** a Spec run on `claude-opus-4.5` attempted the offered `bash` tool, received
  `request_kind_forbidden`, and terminated `missing_permission`; a Brainstorm run on
  `claude-sonnet-4.5` completed against the same shared profile because that model did not choose
  the forbidden tool. The defect was fixed in `b31d875`.

## Input — sibling runtimes apply different policy discipline to one shared profile

At base `bfa402f`, the operator-supplied Copilot runtime profile is a union of tools needed by
different seats. Execute needs a writable command tool, while connected shaping is governed by a
`single_ingress_file` policy whose `commands`, `urls`, `mcp`, credentials, and writes outside one
ingress path are all forbidden.

`CopilotConnectedShapingRuntime.prepare()` spread that shared profile into its runtime input
unchanged:

```ts
const base = {
  ...this.options.profile,
  requested_model: input.requested_model,
  required_available_tools: ["view", "apply_patch"],
  workspace_cwd: input.workspace_cwd,
  limits: input.limits,
};
```

Declaring `view` and `apply_patch` as required only checks that those tools exist. It does not
remove `bash`, `fetch`, or any other shared-profile tool that shaping's policy will reject. Both
the prepared profile and the launched profile therefore expose the unchanged union.

The sibling review runtime already does the missing work in
`createCopilotReviewRuntimeProfile()`: it intersects `available_tools` with the review seat's
allowlist and moves every removed tool into `excluded_tools` before constructing the runtime
profile.

The question this case exams: **does the reviewer compare the sibling profile-build paths and
notice that shaping is offered capabilities its own terminal policy will deny, even though the
permission evaluator fails closed and the full suite is green?**

## Approved output — identify and close the grant/policy mismatch at profile-build time

A passing review must report that `CopilotConnectedShapingRuntime.prepare()` is over-granted at
base `bfa402f`. The expected failure chain is:

1. The shared profile includes a tool such as `bash` because another seat legitimately needs it.
2. Shaping passes that union through unchanged, so the CLI offers `bash` to the model.
3. If the model selects it, normalization produces a command capability request.
4. `evaluateShapingPermissionRequest()` correctly returns `request_kind_forbidden`, because the
   shaping policy permits only the exact ingress-file write.
5. That denial is terminal for the connected run, so the otherwise valid shaping attempt ends
   `missing_permission`.

The denial is not an adequate safety net. It prevents the forbidden command, but it also makes run
success depend on whether a particular model happens to choose an improperly offered tool. That is
why one model can complete while another fails under identical configuration, and why a green
suite using a well-behaved model or only evaluator unit tests does not close the defect.

The correct repair is seat-local narrowing at the point the shaping runtime profile is built:

- Intersect the shared `available_tools` union with shaping-compatible read and ingress-write
  tools.
- Add tools removed from `available_tools` to `excluded_tools`.
- Apply the narrowed pair to both the prepared evidence profile and the launched runtime profile.
- Keep the shared operator profile as the cross-seat union; do not remove `bash` globally, because
  Execute legitimately requires it.

The regression guard should construct a shaping runtime from a deliberately mixed profile and
assert that its sanitized profile retains shaping tools such as `view` and `apply_patch`, excludes
forbidden tools such as `bash` and `fetch`, and records removed tools in `excluded_tools`.

## Grading notes

**A passing answer must contain:**

1. The concrete asymmetry: review narrows its shared tool grant against its seat policy, while
   shaping at `bfa402f` passes the shared union through unchanged.
2. The complete operational consequence from offered `bash` through
   `request_kind_forbidden` to terminal `missing_permission`, including the model-dependent nature
   of the symptom.
3. The repair boundary: narrow tools when building the shaping runtime profile and move removed
   tools to `excluded_tools`, without shrinking the shared union for other seats.
4. A non-vacuous regression test that starts with forbidden tools present in the input profile and
   proves they are absent from the resulting shaping profile.

**Known traps (a failing answer often falls into these):**

- Calling the behavior safe because the permission evaluator rejects `bash`. The command is
  blocked, but the terminal denial still destroys the run; authorization safety and run
  reliability are separate properties.
- Reviewing only `CopilotConnectedShapingRuntime.prepare()` in isolation and missing the sibling
  review builder that demonstrates the intended seat-local narrowing pattern.
- Removing `bash` from the shared environment profile. That makes shaping appear safe by breaking
  Execute's legitimate requirement and preserves the underlying cross-seat configuration bind.
- Weakening the shaping policy, allowing shell commands, or making forbidden calls nonterminal.
  The policy is correct; the offered grant is wrong.
- Treating a green suite or one successful model run as proof. The defect is latent until a model
  chooses a forbidden capability, so the test must inject an over-broad input profile directly.

**Generalizable smell:** whenever one runtime profile is shared across seats with different
policies, the shared profile can only represent the union of their needs. Each seat must intersect
that union with its own policy before tools are offered to the model. A downstream terminal denial
cannot compensate for an upstream over-broad grant; it converts a preventable configuration bug
into model-dependent run loss.

## Source

- `src/application/shaping-connected-run.ts` and
  `src/infrastructure/acp/copilot-runtime-profile.ts` at base `bfa402f`.
- Live run evidence recorded during the 2026-08-09 debugging session: Spec run
  `42e0bbd4-29c2-4b0c-a92f-ed92860705c6` failed `missing_permission`; Brainstorm run prefix
  `0482460f` completed against the same profile.
- Fix `b31d875` (`narrowCopilotShapingTools()` plus
  `tests/application/shaping-connected-run.test.ts`).
