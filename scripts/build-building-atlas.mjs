import { readFile, writeFile } from 'node:fs/promises';

// Code-native SVG atlas: each quadrant keeps its source texture and an edge gutter.
for (const size of [128, 32]) {
  const dir = new URL('../public/textures/city/', import.meta.url);
  const images = Object.fromEntries(await Promise.all(['brick', 'roof', 'metal', 'concrete'].map(async name => [name, `data:image/webp;base64,${(await readFile(new URL(`${name}-${size}.webp`, dir))).toString('base64')}`])));
  const image = (name, x, y, width, height) => `<image href="${images[name]}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none"/>`;
  const gutter = size / 32;
  const inner = size - 2 * gutter;
  const facade = { width: 0.75, height: 0.18, center: 0.55 };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size * 2} ${size * 2}" data-facade-width="${facade.width}" data-facade-height="${facade.height}" data-facade-center="${facade.center}">
${image('roof', 0, 0, size, size)}
${image('brick', size, 0, size, size)}
${image('brick', 0, size, size, size)}
${image('metal', gutter + inner * (1 - facade.width) / 2, size + gutter + inner * (facade.center - facade.height / 2), inner * facade.width, inner * facade.height)}
${image('concrete', size, size, size, size)}
</svg>\n`;
  await writeFile(new URL(`building-shell-${size}.svg`, dir), svg);
}
