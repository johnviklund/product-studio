# Product Studio

## Commands

- `npm run dev` — start the development server.
- `npm run build` — create a production build.
- `npm run lint` — run ESLint.
- `npm run typecheck` — run the TypeScript compiler without emitting files.
- `npm test` — run the test suite.

## Required configuration

Set `PRODUCT_STUDIO_APP_ORIGIN` to the exact loopback origin where the app is served. For
`npm run dev`, which binds to `127.0.0.1`, use:

```sh
export PRODUCT_STUDIO_APP_ORIGIN=http://127.0.0.1:3000
```

Mutating shaping requests require both the `Origin` and `Host` headers to match that configured
origin exactly. When the variable is unset, every shaping mutation fails closed with HTTP 403 and
`untrusted_request_origin`. See [Product principles](PRODUCT.md#3-settled-product-principles) for
the guarantee and trust boundary.

Only a literal loopback address is accepted — `localhost` is rejected. Browse the app at
`http://127.0.0.1:3000`, not `http://localhost:3000`, or the `Host` header will not match and
every mutation fails closed.

## Optional configuration: connected runtime

Connected shaping, Execute, and Review runs require `PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON`,
a JSON runtime profile validated when the portfolio service is first constructed
(`src/application/portfolio-service.ts`). When it is unset, the app still runs, but every seat
reports `runtime_unavailable` and only manual (non-connected) mode is available.

```sh
export PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON='{
  "preflight": {
    "executable": "/absolute/path/to/copilot",
    "version": "1.0.78",
    "authentication": "noninteractive_authenticated",
    "available_model_ids": ["claude-opus-4.5", "claude-sonnet-4.5", "gpt-5.4"]
  },
  "default_model": "claude-sonnet-4.5",
  "reasoning_effort": "medium",
  "available_tools": ["view", "apply_patch", "edit", "create", "bash", "glob", "grep"],
  "excluded_tools": ["ask_user", "web_fetch", "task"],
  "environment": { "PATH": "...", "HOME": "...", "TMPDIR": "/tmp", "LANG": "en_US.UTF-8" }
}'
```

Constraints the schema enforces, each of which fails the run rather than degrading it:

- The executable's basename must be `copilot`. `preflight.version` and
  `preflight.authentication` are **self-declared and not verified** against the installed CLI —
  `preflightCopilotExecutable()` exists but no application path calls it — so a wrong version here
  silently becomes the recorded `adapter_version` provenance. Keep it in sync with
  `copilot --version` by hand.
- `available_tools` must include `bash` (required by the Execute seat) and `view` + `apply_patch`
  (required by the shaping seats). The shaping and Review runtimes narrow this set to their own
  artifact-only write policies before launch, so granting `bash` here does not expose a shell to
  them; the Execute seat keeps it, bounded by its capability envelope.
- `available_tools` and `excluded_tools` must not overlap, and neither may be empty.
- `environment` is an allowlist: only `COPILOT_HOME`, `HOME`, `LANG`, `LC_ALL`, `PATH`, and
  `TMPDIR` are passed through, `PATH` is required, and credential values are never forwarded.

Next.js loads this from a gitignored `.env.local` in development, where the value must be on a
single line (wrap the JSON in single quotes). Changes require a dev-server restart.
