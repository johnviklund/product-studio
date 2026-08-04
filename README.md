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
