import { describe, expect, it } from 'vitest';
import {
  createThickOctahedron,
  markInradius,
  markOctahedronFaces,
  markOctahedronVertices,
  markRadiusForEdge,
  type MarkVec3,
} from '../src/viz/client-gl/mark-geometry.js';

const dot = (a: MarkVec3, b: MarkVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function triangleAt(mesh: ReturnType<typeof createThickOctahedron>, triangle: number) {
  const base = triangle * 9;
  return [0, 1, 2].map((vertex): MarkVec3 => [
    mesh.positions[base + vertex * 3]!,
    mesh.positions[base + vertex * 3 + 1]!,
    mesh.positions[base + vertex * 3 + 2]!,
  ]);
}

describe('regular octahedron hull', () => {
  it('places six vertices on the axes at the edge-length radius', () => {
    const radius = markRadiusForEdge(2);
    expect(radius).toBeCloseTo(Math.SQRT2, 12);
    const vertices = markOctahedronVertices(radius);
    expect(vertices).toHaveLength(6);
    for (const vertex of vertices) {
      expect(Math.hypot(...vertex)).toBeCloseTo(radius, 12);
      // Exactly one non-zero component: every vertex is an axis pole.
      expect(vertex.filter((component) => component !== 0)).toHaveLength(1);
    }
    // All twelve edges are the edge length, which is what makes it REGULAR —
    // the shape this replaces was a scalene bipyramid whose long vertex swung
    // outside the outline as it turned.
    const edges = markOctahedronFaces().flatMap(({ indices }) => {
      const [i, j, k] = indices;
      return [[i, j], [j, k], [k, i]];
    });
    for (const [from, to] of edges) {
      const a = vertices[from!]!;
      const b = vertices[to!]!;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(2, 12);
    }
  });

  it('gives one face per sign octant', () => {
    const faces = markOctahedronFaces();
    expect(faces).toHaveLength(8);
    expect(new Set(faces.map(({ octant }) => octant.join(',')))).toHaveLength(8);
    const radius = 1;
    const vertices = markOctahedronVertices(radius);
    for (const { indices, octant } of faces) {
      const [i, j, k] = indices;
      // The face's own vertices carry the octant's signs, so an octant-keyed
      // palette paints the facet a viewer actually sees in that direction.
      for (const [axis, sign] of octant.entries()) {
        const poles = [vertices[i]!, vertices[j]!, vertices[k]!]
          .map((vertex) => vertex[axis]!)
          .filter((component) => component !== 0);
        expect(poles).toEqual([radius * sign]);
      }
    }
  });

  it('states the inradius the shell thickness is measured against', () => {
    expect(markInradius(Math.sqrt(3))).toBeCloseTo(1, 12);
    const radius = 1.4;
    const inradius = markInradius(radius);
    const vertices = markOctahedronVertices(radius);
    for (const { indices } of markOctahedronFaces()) {
      const [i, j, k] = indices;
      const a = vertices[i]!;
      const b = vertices[j]!;
      const c = vertices[k]!;
      // Plane distance from the centre, computed the long way round.
      const ab: MarkVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: MarkVec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const raw: MarkVec3 = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const length = Math.hypot(...raw);
      expect(Math.abs(dot(raw, a)) / length).toBeCloseTo(inradius, 12);
    }
  });
});

describe('createThickOctahedron', () => {
  const RADIUS = 1.2;
  const THICKNESS = 0.12;
  const mesh = createThickOctahedron(RADIUS, THICKNESS);

  it('builds one closed outer hull and one closed inner hull, and nothing else', () => {
    const counts = { outer: 0, inner: 0 };
    for (const facet of mesh.facets) counts[facet.part] += 1;
    expect(counts).toEqual({ outer: 8, inner: 8 });
    expect(mesh.vertexCount).toBe((8 + 8) * 3);
    expect(mesh.positions).toHaveLength(mesh.vertexCount * 3);
    expect(mesh.normals).toHaveLength(mesh.vertexCount * 3);
    expect(mesh.facets.map((facet) => facet.triangle))
      .toEqual(mesh.facets.map((_facet, index) => index));
  });

  it('scales the inner hull by the homothety the thickness asks for', () => {
    expect(mesh.inradius).toBeCloseTo(markInradius(RADIUS), 12);
    expect(mesh.innerScale).toBeCloseTo(1 - THICKNESS / mesh.inradius, 12);
    const wallDistance = (1 - mesh.innerScale) * mesh.inradius;
    expect(wallDistance).toBeCloseTo(THICKNESS, 12);
    for (const facet of mesh.facets.filter((entry) => entry.part === 'inner')) {
      for (const vertex of triangleAt(mesh, facet.triangle)) {
        expect(Math.hypot(...vertex)).toBeCloseTo(RADIUS * mesh.innerScale, 6);
      }
    }
  });

  it('winds every facet so its flat normal faces the surface the viewer sees', () => {
    for (const facet of mesh.facets) {
      expect(Math.hypot(...facet.normal)).toBeCloseTo(1, 6);
      const facing = dot(facet.normal, facet.centroid);
      if (facet.part === 'inner') {
        // The cavity: its normals point back at the light inside the shell.
        expect(facing, `inner facet ${facet.triangle}`).toBeLessThan(0);
      } else {
        expect(facing, `outer facet ${facet.triangle}`).toBeGreaterThan(0);
      }
      // A facet whose plane passes through the centre faces NEITHER way, which
      // is exactly what a homothetic side band does — the shell must not carry
      // one, so no facet may sit at zero.
      expect(Math.abs(facing), `facet ${facet.triangle} is edge-on`)
        .toBeGreaterThan(1e-6);
      // Flat shading: the three vertices of a triangle share ONE normal, so the
      // facets read as planes and the rank edges stay crisp.
      const base = facet.triangle * 9;
      for (const vertex of [0, 1, 2]) {
        for (const axis of [0, 1, 2]) {
          expect(mesh.normals[base + vertex * 3 + axis]).toBeCloseTo(facet.normal[axis]!, 6);
        }
      }
    }
  });

  it('keeps every facet inside the hull it was cut from', () => {
    for (const facet of mesh.facets) {
      for (const vertex of triangleAt(mesh, facet.triangle)) {
        expect(Math.hypot(...vertex)).toBeLessThanOrEqual(RADIUS + 1e-6);
      }
    }
  });

  it('refuses a thickness the shell cannot hold', () => {
    expect(() => createThickOctahedron(1, markInradius(1))).toThrow(RangeError);
    expect(() => createThickOctahedron(1, markInradius(1) + 0.1)).toThrow(RangeError);
    expect(() => createThickOctahedron(1, 0)).toThrow(RangeError);
    expect(() => createThickOctahedron(0, 0.1)).toThrow(RangeError);
    expect(() => createThickOctahedron(1, -0.1)).toThrow(RangeError);
  });
});
