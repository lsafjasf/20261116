import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let crcTable = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function encodePng(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("PNG dimensions must be positive integers");
  }
  if (pixels.length !== width * height * 4) throw new RangeError("RGBA buffer size mismatch");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), rowOffset + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function unfilter(raw, width, height) {
  const stride = width * 4;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error("Truncated PNG image data");
  const output = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const aboveStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawValue = raw[rowStart + x];
      const left = x >= 4 ? output[outStart + x - 4] : 0;
      const above = y > 0 ? output[aboveStart + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? output[aboveStart + x - 4] : 0;
      let value;
      if (filter === 0) value = rawValue;
      else if (filter === 1) value = rawValue + left;
      else if (filter === 2) value = rawValue + above;
      else if (filter === 3) value = rawValue + Math.floor((left + above) / 2);
      else if (filter === 4) value = rawValue + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}`);
      output[outStart + x] = value & 0xff;
    }
  }
  return output;
}

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG file");
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header) throw new Error("PNG has no IHDR chunk");
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error("Only 8-bit non-interlaced RGBA PNG is supported");
  }
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), header.width, header.height);
  return { width: header.width, height: header.height, pixels };
}

export function pngDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export function dataUrlToPng(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl ?? "");
  if (!match) throw new Error("Invalid PNG data URL");
  return Buffer.from(match[1], "base64");
}
