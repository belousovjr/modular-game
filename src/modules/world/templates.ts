import type { ObjectTemplate } from '../object-templates/index.ts';
import type { GeometryPart } from '../geometry/index.ts';

const span = { default: 10, min: 0.001, max: 2048 };
export const worldTemplates: readonly ObjectTemplate[] = [
  ...['terrain', 'road', 'sidewalk', 'curb'].map((surface): ObjectTemplate => ({
    id: `world/${surface}`, version: 3,
    parameters: { width: span, depth: span, thickness: { default: 0.3, min: 0.01, max: 2 } },
    build: ({ width, depth, thickness }) => ({ hideDistance: surface === 'terrain' ? 500 : surface === 'road' ? 150 : surface === 'sidewalk' ? 100 : 20, levels: [{ distance: 0, parts: [
      { surface, size: [width, thickness, depth], position: [0, -thickness / 2, 0] },
    ] }] }),
  })),
  {
    id: 'world/building', version: 7,
    parameters: { width: span, depth: span, height: { default: 8, min: 3, max: 30 }, foundation: { default: 0.5, min: 0.1, max: 5 } },
    build({ width, depth, height, foundation }) {
      const body: GeometryPart = {
        surface: 'building-shell', size: [width, height, depth], position: [0, height / 2, 0],
        // +Z/-Z facade, +X/-X plain wall, +Y roof, -Y foundation; 1/32 tile gutters.
        faceUV: [
          [1 / 64, 1 / 64, 31 / 64, 31 / 64], [1 / 64, 1 / 64, 31 / 64, 31 / 64],
          [33 / 64, 33 / 64, 63 / 64, 63 / 64], [33 / 64, 33 / 64, 63 / 64, 63 / 64],
          [1 / 64, 33 / 64, 31 / 64, 63 / 64], [33 / 64, 1 / 64, 63 / 64, 31 / 64],
        ],
      };
      const parts: GeometryPart[] = [
        body,
        { surface: 'roof', size: [width + 0.6, 0.25, depth + 0.6], position: [0, height + 0.125, 0] },
        { surface: 'foundation', size: [width + 0.4, foundation, depth + 0.4], position: [0, -foundation / 2, 0] },
      ];
      const facade = [-1, 1].map((side): GeometryPart => ({
        surface: 'facade', size: [width * 0.75, height * 0.18, 0.6], position: [0, height * 0.55, side * (depth / 2 + 0.3)],
      }));
      return { hideDistance: 120, levels: [
        { distance: 0, parts: [...parts, ...facade] }, { distance: 8, parts }, { distance: 22, parts: [body] },
      ] };
    },
  },
  {
    id: 'world/lamp', version: 3, parameters: {},
    build: () => {
      const pole: GeometryPart = { surface: 'metal', size: [0.14, 4.5, 0.14], position: [0, 2.15, 0] };
      const head: GeometryPart = { surface: 'lamp-head', size: [0.5, 0.15, 0.35], position: [1.15, 4.3, 0] };
      return { hideDistance: 40, levels: [
        { distance: 0, parts: [pole, head,
          { surface: 'foundation', size: [0.6, 0.3, 0.6], position: [0, 0.05, 0] },
          { surface: 'metal', size: [1.2, 0.12, 0.12], position: [0.6, 4.3, 0] },
        ] },
        { distance: 8, parts: [{ surface: 'metal', size: [0.18, 4.5, 0.18], position: [0, 2.15, 0] }] },
      ] };
    },
  },
  {
    id: 'world/plaza', version: 1, parameters: {},
    build: () => ({ hideDistance: 300, levels: [{ distance: 0, parts: [
      { surface: 'sidewalk', size: [6, 0.45, 6], position: [0, -0.225, 0] },
      { surface: 'foundation', size: [2, 0.5, 2], position: [0, 0.25, 0] },
      { surface: 'metal', size: [0.8, 2.5, 0.8], position: [0, 1.75, 0], rotation: [0, Math.PI / 4, 0] },
    ] }] }),
  },
];
