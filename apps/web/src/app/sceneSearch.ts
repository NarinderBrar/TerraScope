/**
 * Collecting every scene over a view for a date range.
 *
 * Long ranges return a lot of catalog entries: each acquisition is listed per
 * collection and per ~110 km granule the view touches, so six months over a
 * view at a granule corner is over a thousand entries. Reading them as one
 * paged, oldest-first stream and stopping at a page limit silently drops the
 * newest months. So the range is split by calendar month, months are searched
 * a few at a time with their own paging, the newer collection is asked first
 * (roughly halving the entries), and hitting a limit is reported, not hidden.
 */

import type { Scene } from '@terrascope/contracts';
import type { RasterClient } from '../data/RasterClient';

/** Reprocessed, consistent collection; the older one fills months it lacks. */
const PRIMARY_COLLECTION = 'sentinel-2-c1-l2a';
const FALLBACK_COLLECTION = 'sentinel-2-l2a';
const PAGE_SIZE = 50;
/** Per month. A month over a four-granule view is ~200 entries in one collection. */
const MAX_PAGES_PER_MONTH = 8;
/** Months searched at once: fast for multi-year ranges, without flooding the catalog. */
const MONTH_CONCURRENCY = 6;
/** Sentinel-2A launched on 23 June 2015; nothing exists before it. */
export const MISSION_START = '2015-06-23';

type Bounds = { west: number; south: number; east: number; north: number };

export interface ViewSearchResult {
  scenes: Scene[];
  /** Months where the page limit was reached, so some scenes may be missing. */
  truncatedMonths: string[];
  /** The range actually searched, after clamping to the mission's lifetime. */
  searched: { from: string; to: string } | null;
}

/** Calendar-month slices of [from, to], as inclusive YYYY-MM-DD pairs. */
export function monthChunks(from: string, to: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cursor <= last) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const end = monthEnd < last ? monthEnd : last;
    chunks.push({ start: iso(cursor), end: iso(end) });
    cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  }
  return chunks;
}

export async function searchView(
  client: RasterClient,
  view: Bounds,
  from: string,
  to: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ViewSearchResult> {
  // Searching before launch or after today costs requests and finds nothing:
  // 2010-2024 would otherwise spend ~130 searches on the years before 2015.
  const today = new Date().toISOString().slice(0, 10);
  const start = from > MISSION_START ? from : MISSION_START;
  const end = to < today ? to : today;
  if (start > end) return { scenes: [], truncatedMonths: [], searched: null };
  const months = monthChunks(start, end);
  const scenes: Scene[] = [];
  const truncatedMonths: string[] = [];
  let done = 0;
  let next = 0;
  // One failed month fails the search. The flag stops the other workers, so
  // they neither keep issuing requests nor report progress after the caller
  // has already been told it failed.
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < months.length) {
      const month = months[next++];
      try {
        let result = await searchMonth(client, view, month, PRIMARY_COLLECTION);
        // Older archive months may predate the reprocessed collection.
        if (result.scenes.length === 0) result = await searchMonth(client, view, month, FALLBACK_COLLECTION);
        scenes.push(...result.scenes);
        if (result.truncated) truncatedMonths.push(month.start.slice(0, 7));
      } catch (error) {
        failed = true;
        throw error;
      }
      if (!failed) onProgress?.(++done, months.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MONTH_CONCURRENCY, months.length) }, worker));
  scenes.sort((a, b) => a.datetime.localeCompare(b.datetime));
  truncatedMonths.sort();
  return { scenes, truncatedMonths, searched: { from: start, to: end } };
}

async function searchMonth(
  client: RasterClient,
  view: Bounds,
  month: { start: string; end: string },
  collection: string,
): Promise<{ scenes: Scene[]; truncated: boolean }> {
  const scenes: Scene[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_MONTH; page += 1) {
    const response = await client.search({
      bbox: [view.west, view.south, view.east, view.north],
      start: `${month.start}T00:00:00Z`,
      end: `${month.end}T23:59:59Z`,
      limit: PAGE_SIZE,
      sort: 'asc',
      collections: [collection],
      ...(cursor ? { cursor } : {}),
    });
    scenes.push(...response.scenes);
    cursor = response.nextCursor ?? undefined;
    if (!cursor || response.scenes.length === 0) return { scenes, truncated: false };
  }
  return { scenes, truncated: cursor !== undefined };
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
