import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(projectRoot, 'assets', 'source');
const outputDir = path.join(projectRoot, 'assets', 'generated');

await mkdir(outputDir, { recursive: true });

const renderPng = async (sourceName, outputName, size) => {
  const source = await readFile(path.join(sourceDir, sourceName));
  await sharp(source)
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(outputDir, outputName));
};

for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  await renderPng('app-icon.svg', `app-icon-${size}.png`, size);
}

for (const phase of ['idle', 'running', 'error']) {
  await renderPng(`tray-${phase}.svg`, `tray-${phase}.png`, 32);
}

const ico = await pngToIco(
  [16, 24, 32, 48, 64, 128, 256].map((size) => path.join(outputDir, `app-icon-${size}.png`)),
);
await writeFile(path.join(outputDir, 'app-icon.ico'), ico);
