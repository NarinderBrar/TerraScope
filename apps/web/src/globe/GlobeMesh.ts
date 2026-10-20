import { lonLatToUnitSphere, xyzUvToLonLat } from './GlobeMath';
import type { GlobeTile } from './GlobeTiles';

export interface GlobeMeshData {
  /** xyz position followed by uv, six float32 values per vertex. */
  vertices: Float32Array;
  indices: Uint32Array;
}

/** Build a tessellated XYZ tile patch on a unit sphere. */
export function buildGlobeTileMesh(tile: GlobeTile, segments = 16, elevation?: Float32Array): GlobeMeshData {
  const side = segments + 1;
  const vertices = new Float32Array(side * side * 5);
  const indices = new Uint32Array(segments * segments * 6);

  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      const u = column / segments;
      const v = row / segments;
      const [longitude, latitude] = xyzUvToLonLat(tile.z, tile.x, tile.y, u, v);
      const sample = elevation
        ? Math.round(v * (side - 1)) * side + Math.round(u * (side - 1))
        : -1;
      // Elevation values are metres. Radius is a unit sphere, so convert to a
      // small dimensionless displacement while retaining relative relief.
      const height = sample >= 0 ? elevation![sample] / 6_378_137 : 0;
      const point = lonLatToUnitSphere(longitude, latitude, height);
      const offset = (row * side + column) * 5;
      vertices[offset] = point.x;
      vertices[offset + 1] = point.y;
      vertices[offset + 2] = point.z;
      vertices[offset + 3] = u;
      vertices[offset + 4] = v;
    }
  }

  let cursor = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const topLeft = row * side + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + side;
      const bottomRight = bottomLeft + 1;
      indices[cursor++] = topLeft;
      indices[cursor++] = topRight;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = topRight;
      indices[cursor++] = bottomRight;
      indices[cursor++] = bottomLeft;
    }
  }

  return { vertices, indices };
}
