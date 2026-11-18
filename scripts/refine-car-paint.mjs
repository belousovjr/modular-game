import assert from 'node:assert/strict';
import sharp from 'sharp';

export async function refineCarPaint(document, atlas) {
  const { data, info } = await sharp(atlas.getImage()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  assert.equal(channels, 3);
  const doorPanels = new Set();
  for (const door of document.getRoot().listNodes().filter(node => node.getName().startsWith('door/'))) {
    const side = Math.sign(door.getTranslation()[0]);
    for (const primitive of door.getMesh().listPrimitives()) {
      if (primitive.getMaterial().getName() !== 'car/textured') continue;
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      const normal = primitive.getAttribute('NORMAL');
      const uv = primitive.getAttribute('TEXCOORD_0');
      for (let start = 0; start < indices.getCount(); start += 3) {
        const vertices = [0, 1, 2].map(offset => indices.getScalar(start + offset));
        if (!vertices.every(vertex => normal.getElement(vertex, [])[0] * side > .96)) continue;
        const points = vertices.map(vertex => position.getElement(vertex, []));
        const panelArea = Math.abs((points[1][1] - points[0][1]) * (points[2][2] - points[0][2]) -
          (points[2][1] - points[0][1]) * (points[1][2] - points[0][2])) / 2;
        if (panelArea < .15 || points.some(point => point[1] + door.getTranslation()[1] > 1.2)) continue;
        const [u, v] = uv.getElement(vertices[0], []);
        doorPanels.add(Math.floor(v * height / 8) * (width / 8) + Math.floor(u * width / 8));
      }
    }
  }
  assert.ok(doorPanels.size >= 4, 'Expected the lower exterior door panels on both doors');

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    const red = data[i], green = data[i + 1], blue = data[i + 2];
    const steelBlue = blue > green * 1.28 && green > red * 1.7;
    const doorPanel = doorPanels.has(Math.floor(y / 8) * (width / 8) + Math.floor(x / 8));
    if (!steelBlue && !doorPanel) continue;
    // Keep a restrained amount of the baked occlusion on the painted shell.
    const shade = steelBlue ? .85 + .15 * Math.min(1, blue / 183) : .97;
    data[i] = Math.round(61 * shade);
    data[i + 1] = Math.round(94 * shade);
    data[i + 2] = Math.round(122 * shade);
  }
  atlas.setImage(await sharp(data, { raw: info }).webp({ lossless: true }).toBuffer());
  for (const material of document.getRoot().listMaterials()) {
    if (material.getBaseColorTexture() === atlas) material.getBaseColorTextureInfo().setMinFilter(9729);
  }
}
