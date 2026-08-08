import { describe, expect, it } from 'vitest';
import { inspectSafeImage, MAX_SAFE_IMAGE_DIMENSION } from '../src/main/image-safety';

const png = (width = 1, height = 1): Buffer => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

describe('native image safety', () => {
  it('derives PNG identity and dimensions from bytes rather than the claimed MIME', () => {
    expect(inspectSafeImage(png(320, 180), 'preview.png')).toEqual({
      height: 180,
      mediaType: 'image/png',
      width: 320,
    });
    expect(() => inspectSafeImage(png(), 'preview.jpg')).toThrow(/扩展名与实际内容不一致/);
  });

  it('rejects SVG, corrupt payloads and decompression-sized dimensions', () => {
    expect(() => inspectSafeImage(Buffer.from('<svg><script/></svg>'), 'image.svg')).toThrow(
      /不支持 SVG/,
    );
    expect(() => inspectSafeImage(Buffer.from('not an image'), 'image.png')).toThrow(/格式无效/);
    expect(() => inspectSafeImage(png(MAX_SAFE_IMAGE_DIMENSION + 1, 1), 'oversized.png')).toThrow(
      /像素尺寸过大/,
    );
  });
});
