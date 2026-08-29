# Showcase web

Static Preact frontend for the frozen showcase API in `research/edge-case-corpus/SHOWCASE-PLAN.md` §5.

```bash
# frontend plus a contract-compatible mock API
pnpm --filter showcase-web dev -- --mock

# production assets (written to dist/ for the showcase server to mount at /)
pnpm --filter showcase-web build

# serve the production build and mock API together on 127.0.0.1:4317
pnpm --filter showcase-web mock -- --static
```

The mock implements `POST /api/jobs`, gallery and full-index reads, SSE stage events, and artifact URLs. It intentionally returns stills instead of inventing video evidence. Pass a shared server token as `?token=...`; the frontend preserves it on API, SSE, and artifact requests.
