# Reproducible benchmark

Record the application revision, browser, GPU, OS, screen resolution, network conditions, and whether each request is cold, edge-cached, or R2-cached.

Start the local raster service or provide a deployed base URL, then run:

```bash
TERRASCOPE_API_BASE=http://127.0.0.1:8080 node scripts/benchmark.mjs
```

The script uses the fixed Sacramento Valley bbox and June–July 2024 range, selects the newest returned scene, fetches the same z13 RGBN tile twice, and reports search latency, first/warm tile latency, bytes, and cache headers. Browser frame/GPU/decode measurements appear in the application’s Performance panel. GPU allocation is an application estimate.
