import path from 'node:path';

export interface SafeImageInfo {
  height: number;
  mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
}

export const MAX_SAFE_IMAGE_PIXELS = 40_000_000;
export const MAX_SAFE_IMAGE_DIMENSION = 16_384;

const extensionMedia: Readonly<Record<string, SafeImageInfo['mediaType']>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const isPng = (bytes: Buffer): boolean =>
  bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

const jpegDimensions = (bytes: Buffer): { height: number; width: number } | undefined => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && length >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
};

const webpDimensions = (bytes: Buffer): { height: number; width: number } | undefined => {
  if (
    bytes.length < 30 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return undefined;
  }
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    return { height: 1 + bytes.readUIntLE(27, 3), width: 1 + bytes.readUIntLE(24, 3) };
  }
  if (kind === 'VP8L' && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return {
      height: 1 + ((packed >> 14) & 0x3fff),
      width: 1 + (packed & 0x3fff),
    };
  }
  if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      height: bytes.readUInt16LE(28) & 0x3fff,
      width: bytes.readUInt16LE(26) & 0x3fff,
    };
  }
  return undefined;
};

export const inspectSafeImage = (bytes: Buffer, fileName: string): SafeImageInfo => {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 512)).toString('utf8').trimStart();
  if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(prefix)) {
    throw new Error('不支持 SVG 图片；请转换为 PNG、JPEG、GIF 或 WebP。');
  }

  let mediaType: SafeImageInfo['mediaType'] | undefined;
  let dimensions: { height: number; width: number } | undefined;
  if (isPng(bytes)) {
    mediaType = 'image/png';
    dimensions = { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
  } else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.length >= 10) {
    mediaType = 'image/gif';
    dimensions = { height: bytes.readUInt16LE(8), width: bytes.readUInt16LE(6) };
  } else {
    const jpeg = jpegDimensions(bytes);
    const webp = webpDimensions(bytes);
    if (jpeg) {
      mediaType = 'image/jpeg';
      dimensions = jpeg;
    } else if (webp) {
      mediaType = 'image/webp';
      dimensions = webp;
    }
  }
  if (!mediaType || !dimensions) throw new Error('图片格式无效或文件已损坏。');

  const expected = extensionMedia[path.extname(fileName).toLowerCase()];
  if (!expected || expected !== mediaType) {
    throw new Error('图片扩展名与实际内容不一致。');
  }
  const { height, width } = dimensions;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_SAFE_IMAGE_DIMENSION ||
    height > MAX_SAFE_IMAGE_DIMENSION ||
    width * height > MAX_SAFE_IMAGE_PIXELS
  ) {
    throw new Error('图片像素尺寸过大或无效。');
  }
  return { height, mediaType, width };
};
