/**
 * Place search with suggestions, backed by Photon (komoot, OpenStreetMap data).
 *
 * Photon is built for search-as-you-type; Nominatim's usage policy forbids
 * autocomplete, which is why it is not used here. Requests are debounced,
 * cancelled when superseded, and biased toward the current map centre so
 * "Springfield" means the nearby one first.
 */

import { useEffect, useRef, useState } from 'react';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 5;

export interface Place {
  name: string;
  /** Region and country, for telling identically named places apart. */
  context: string;
  kind: string;
  lon: number;
  lat: number;
  bounds: { west: number; south: number; east: number; north: number } | null;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_value?: string;
    /** [west, north, east, south] -- Photon's order, not GeoJSON's. */
    extent?: [number, number, number, number];
  };
}

export function PlaceSearch({
  near,
  onPick,
}: {
  near: { lon: number; lat: number };
  onPick: (place: Place) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The bias point is read when a request is made, not a reason to re-run it.
  const nearRef = useRef(near);
  nearRef.current = near;

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setPlaces([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        q: text,
        limit: String(MAX_SUGGESTIONS),
        lat: nearRef.current.lat.toFixed(4),
        lon: nearRef.current.lon.toFixed(4),
      });
      fetch(`${PHOTON_URL}?${params}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`place search failed (${response.status})`);
          return response.json() as Promise<{ features: PhotonFeature[] }>;
        })
        .then((body) => {
          setPlaces(body.features.map(toPlace).slice(0, MAX_SUGGESTIONS));
          setActive(0);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const pick = (place: Place | undefined): void => {
    if (!place) return;
    setQuery(place.name);
    setOpen(false);
    onPick(place);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(places.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(places[active] ?? places[0]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && places.length > 0;
  return (
    <div className="place-search">
      <input
        type="search"
        placeholder="Search a place…"
        value={query}
        role="combobox"
        aria-expanded={showList}
        aria-controls="place-suggestions"
        aria-autocomplete="list"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Delay so a click on a suggestion lands before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul id="place-suggestions" className="suggestions" role="listbox">
          {places.map((place, i) => (
            <li
              key={`${place.lon},${place.lat},${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(place);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="name">{place.name}</span>
              <span className="context">{[place.kind, place.context].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
      <p className="attribution small dim">Search by Photon · © OpenStreetMap contributors</p>
    </div>
  );
}

function toPlace(feature: PhotonFeature): Place {
  const p = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  const extent = p.extent;
  return {
    name: p.name ?? p.city ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    context: [p.state, p.country].filter(Boolean).join(', '),
    kind: p.osm_value ?? '',
    lon,
    lat,
    bounds: extent
      ? { west: extent[0], north: extent[1], east: extent[2], south: extent[3] }
      : null,
  };
}

/** A sensible zoom for a place with no extent, by what kind of place it is. */
export function zoomForKind(kind: string): number {
  switch (kind) {
    case 'country': return 5;
    case 'state': return 7;
    case 'county': return 9;
    case 'city': return 11;
    case 'town': case 'municipality': return 12;
    case 'village': case 'suburb': return 13;
    default: return 14;
  }
}
