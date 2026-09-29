/**
 * Regenerate the EOT1 tile fixtures the web test suite decodes.
 *
 * Fetches one rgb and one rgbn tile from the live service and base64-embeds
 * them. The committed blobs are what let `npm test` check the TypeScript
 * decoder against bytes the Python encoder actually produced, with no service
 * and no network.
 *
 *   node scripts/embed-tile-fixtures.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const target = join(repo, 'apps/web/tests/fixtures/tiles.ts');

const BASE = process.env.RASTER_URL ?? 'http://127.0.0.1:8080';
const COLLECTION = process.env.COLLECTION ?? 'sentinel-2-l2a';
const SCENE = process.env.SCENE ?? 'S2B_10SFH_20240627_0_L2A';
const Z = Number(process.env.Z ?? 13);
const X = Number(process.env.X ?? 1335);
const Y = Number(process.env.Y ?? 3156);

async function fetchTile(profile) {
  const url = `${BASE}/api/tiles/${COLLECTION}/${SCENE}/${Z}/${X}/${Y}?profile=${profile}`;
  process.stdout.write(`fetching ${profile} ... `);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text().catch(() => '')}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`${(buffer.length / 1024).toFixed(0)} KiB`);
  return buffer;
}

const rgb = await fetchTile('rgb');
const rgn = await fetchTile('rgbn');

const source = `/**
 * EOT1 tile fixtures -- GENERATED FILE. Do not edit by hand.
 *
 * Regenerate with \`node scripts/embed-tile-fixtures.mjs\` against a running
 * raster service. Each blob is the exact byte stream the Python encoder
 * produced for a real Sentinel-2 granule, so a drift between the Python and
 * TypeScript implementations shows up as a failed assertion rather than as
 * two consistently-wrong decoders agreeing.
 *
 * scene  ${SCENE}
 * tile   z${Z}/x${X}/y${Y}
 */

export const RGB_TILE_BASE64 =
  '${rgb.toString('base64')}';

export const RGN_TILE_BASE64 =
  '${rgn.toString('base64')}';
`;

await mkdir(dirname(target), { recursive: true });
await writeFile(target, source, 'utf8');
console.log(
  `\nWrote ${target}\n  rgb  ${(rgb.length / 1024).toFixed(0)} KiB -> ${(rgb.toString('base64').length / 1024).toFixed(0)} KiB base64\n  rgn  ${(rgn.length / 1024).toFixed(0)} KiB -> ${(rgn.toString('base64').length / 1024).toFixed(0)} KiB base64`,
);
