/**
 * Regenerate `apps/web/tests/parity/referenceFixture.ts` from a live capture.
 *
 * Runs the network-marked Python test, which writes
 * `tests/fixtures/cpu_reference.npz`, then base64-embeds the file into the
 * TypeScript fixture. The committed fixture is what lets the parity suite run
 * in a clean checkout with no raster service, no network, and no Python.
 *
 *   node scripts/embed-reference.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const npzPath = join(repo, 'tests/fixtures/cpu_reference.npz');
const metaPath = join(repo, 'tests/fixtures/cpu_reference.json');
const targetPath = join(repo, 'apps/web/tests/parity/referenceFixture.ts');
const python = join(repo, 'services/raster/.venv/bin/python');

const run = spawnSync(
  python,
  ['-m', 'pytest', 'tests/integration/test_live_pipeline.py', '-m', 'network', '-q', '-k', 'gpu_parity_reference'],
  {
    cwd: repo,
    env: { ...process.env, PYTHONPATH: join(repo, 'services/raster') },
    stdio: 'inherit',
  },
);
if (run.status !== 0) {
  console.error('\nReference generation failed; fixture left untouched.');
  process.exit(run.status ?? 1);
}

const npz = await readFile(npzPath);
const meta = JSON.parse(await readFile(metaPath, 'utf8'));
const base64 = npz.toString('base64');

const source = `/**
 * CPU reference fixture -- GENERATED FILE. Do not edit by hand.
 *
 * Regenerate with \`node scripts/embed-reference.mjs\`.
 *
 * These are the exact float32 values and uint8 masks that
 * \`services/raster/app/tiles/analysis.py\` produced for a real Sentinel-2
 * granule, which is what the GPU kernels are held to.
 *
 * scene    ${meta.scene}
 * tile     z${meta.z}/x${meta.x}/y${meta.y}
 * size     ${meta.width}x${meta.height}
 * epsilon  ${meta.epsilon}
 * datetime ${meta.datetime}
 */

/** Base64 of \`tests/fixtures/cpu_reference.npz\`. */
export const CPU_REFERENCE_BASE64 =
  '${base64}';

/** Contents of \`tests/fixtures/cpu_reference.json\`, inlined. */
export const CPU_REFERENCE_META = ${JSON.stringify(meta, null, 2)} as const;
`;

await writeFile(targetPath, source, 'utf8');
console.log(
  `\nWrote ${targetPath}\n  npz    ${(npz.length / 1024).toFixed(0)} KiB\n  base64 ${(base64.length / 1024).toFixed(0)} KiB`,
);
