# Deployment

## Prerequisites

- Cloudflare Workers account with Containers access.
- Wrangler authentication for the intended account.
- Docker available to Wrangler.
- R2 buckets `terrascope-tiles`, `terrascope-tiles-staging`, and optionally `terrascope-tiles-dev`.

Apply a bounded lifecycle rule to the tile buckets. EOT1 keys contain the processing version, scene, tile grid, profile, and quality policy; changing processing semantics therefore cannot reuse old bytes.

## Validate

```bash
npm install
npm run verify
npm run build
npm --workspace @terrascope/edge run types
npm --workspace @terrascope/edge run typecheck
npm --workspace @terrascope/edge run dry-run
```

The dry run intentionally skips rebuilding the container so it can validate the Worker bundle on machines without Docker. A real deployment builds and rolls out [services/raster/Dockerfile](../services/raster/Dockerfile).

## Release

```bash
npm run deploy:staging
curl -f https://YOUR-STAGING-HOST/raster/api/health
npm run deploy
curl -f https://YOUR-PRODUCTION-HOST/raster/api/health
```

After deployment, exercise an uncached tile, repeat it to observe `X-TerraScope-Cache`, test an invalid scene, and wait for an idle container before testing cold-start behavior. Container provisioning may take several minutes immediately after the first deployment.

No application secret is currently required. If a future provider needs credentials, use `wrangler secret put`; never place secrets in `wrangler.jsonc` or Vite variables.
