import assert from 'node:assert/strict';

export function closeCharacterNeck(document, skinSlot) {
  assert.ok(Number.isInteger(skinSlot) && skinSlot >= 0 && skinSlot < 4);
  const root = document.getRoot();
  const primitive = root.listMeshes()[0].listPrimitives()[0];
  const position = primitive.getAttribute('POSITION');
  const uv = primitive.getAttribute('TEXCOORD_0');
  const indices = primitive.getIndices();
  const spine = root.listSkins()[0].listJoints().findIndex(joint => joint.getName() === 'spine_03');
  assert.ok(spine >= 0);
  const edges = new Map();
  const key = vertex => position.getElement(vertex, []).map(value => Math.round(value * 1e5)).join(',');
  for (let start = 0; start < indices.getCount(); start += 3) {
    const triangle = [0, 1, 2].map(offset => indices.getScalar(start + offset));
    if (!triangle.every(vertex => {
      const [x, y] = position.getElement(vertex, []);
      const [u, v] = uv.getElement(vertex, []);
      return Math.abs(x) < .15 && y >= 1.49 && Math.floor(u * 2) + 2 * Math.floor(v * 2) === skinSlot;
    })) continue;
    for (let i = 0; i < 3; i++) {
      const a = triangle[i], b = triangle[(i + 1) % 3];
      const id = [key(a), key(b)].sort().join('/');
      const edge = edges.get(id) ?? { a, b, count: 0 };
      edge.count++;
      edges.set(id, edge);
    }
  }
  const cut = [...edges.values()].filter(({ a, b, count }) => count === 1 &&
    [a, b].every(vertex => position.getElement(vertex, [])[1] < 1.56));
  const boundary = new Map(cut.map(({ a, b }) => [key(a), key(b)]));
  assert.ok(boundary.size >= 20 && boundary.size === cut.length, 'Expected the open neck ring');
  const first = key(cut[0].a);
  let next = first;
  for (let i = 0; i < cut.length; i++) {
    next = boundary.get(next);
    assert.ok(next && (next !== first || i === cut.length - 1), 'Neck edge must form one loop');
  }
  assert.equal(next, first);

  const attributes = new Map(primitive.listSemantics().map(name => [name, []]));
  const lower = new Map();
  function append(vertex, target, normal) {
    const index = position.getCount() + attributes.get('POSITION').length / 3;
    for (const [name, values] of attributes) {
      const replacements = { POSITION: target, NORMAL: normal, JOINTS_0: [spine, 0, 0, 0], WEIGHTS_0: [1, 0, 0, 0] };
      values.push(...(replacements[name] ?? primitive.getAttribute(name).getElement(vertex, [])));
    }
    return index;
  }
  for (const { a } of cut) {
    const [x, , z] = position.getElement(a, []);
    lower.set(key(a), append(a, [x * 1.28, 1.425, -.06 + (z + .06) * 1.18]));
  }
  const center = append(cut[0].a, [0, 1.425, -.06], [0, -1, 0]);
  const faces = [];
  for (const { a, b } of cut) {
    const lowA = lower.get(key(a)), lowB = lower.get(key(b));
    faces.push(b, a, lowA, b, lowA, lowB, lowB, lowA, center);
  }
  for (const [name, extra] of attributes) {
    const accessor = primitive.getAttribute(name);
    const original = accessor.getArray();
    const array = new original.constructor(original.length + extra.length);
    array.set(original);
    array.set(extra, original.length);
    accessor.setArray(array);
  }
  indices.setArray(new Uint32Array([...indices.getArray(), ...faces]));
}
