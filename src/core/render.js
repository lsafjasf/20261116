export function renderAtlas(packer, frames) {
  const frameById = frames instanceof Map ? frames : new Map(frames.map((frame) => [frame.id, frame]));
  const output = new Uint8ClampedArray(packer.width * packer.height * 4);
  for (const placement of packer.placements.values()) {
    const source = frameById.get(placement.id);
    if (!source) throw new Error(`Missing source pixels for ${placement.id}`);
    blitTrimmed(source, placement, output, packer.width);
  }
  return {
    width: packer.width,
    height: packer.height,
    pixels: output,
  };
}

function blitTrimmed(source, placement, targetPixels, targetWidth) {
  const trim = placement.trimRect;
  const rotatedWidth = trim.h;
  for (let sourceY = trim.y; sourceY < trim.y + trim.h; sourceY += 1) {
    for (let sourceX = trim.x; sourceX < trim.x + trim.w; sourceX += 1) {
      const localX = sourceX - trim.x;
      const localY = sourceY - trim.y;
      const targetX = placement.x + (placement.rotated ? trim.h - 1 - localY : localX);
      const targetY = placement.y + (placement.rotated ? localX : localY);
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      targetPixels[targetOffset] = source.pixels[sourceOffset];
      targetPixels[targetOffset + 1] = source.pixels[sourceOffset + 1];
      targetPixels[targetOffset + 2] = source.pixels[sourceOffset + 2];
      targetPixels[targetOffset + 3] = source.pixels[sourceOffset + 3];
    }
  }
  if (placement.rotated && rotatedWidth < 0) {
    throw new Error("Invalid rotated frame");
  }
}

export function extractTrimmed(slice, atlas) {
  const width = slice.spriteSourceSize.w;
  const height = slice.spriteSourceSize.h;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const packedX = slice.frame.x + (slice.rotated ? height - 1 - y : x);
      const packedY = slice.frame.y + (slice.rotated ? x : y);
      const sourceOffset = (packedY * atlas.width + packedX) * 4;
      const targetOffset = (y * width + x) * 4;
      output[targetOffset] = atlas.pixels[sourceOffset];
      output[targetOffset + 1] = atlas.pixels[sourceOffset + 1];
      output[targetOffset + 2] = atlas.pixels[sourceOffset + 2];
      output[targetOffset + 3] = atlas.pixels[sourceOffset + 3];
    }
  }
  return { width, height, pixels: output };
}

export function restoreOriginalFrame(slice, atlas) {
  const width = slice.sourceSize.w;
  const height = slice.sourceSize.h;
  const output = new Uint8ClampedArray(width * height * 4);
  const trimmed = extractTrimmed(slice, atlas);
  const offsetX = slice.spriteSourceSize.x;
  const offsetY = slice.spriteSourceSize.y;
  for (let y = 0; y < trimmed.height; y += 1) {
    for (let x = 0; x < trimmed.width; x += 1) {
      const sourceOffset = (y * trimmed.width + x) * 4;
      const targetOffset = ((y + offsetY) * width + x + offsetX) * 4;
      output.set(trimmed.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width, height, pixels: output };
}

export function pixelsEqual(left, right) {
  if (left.width !== right.width || left.height !== right.height) return false;
  if (left.pixels.length !== right.pixels.length) return false;
  for (let index = 0; index < left.pixels.length; index += 1) {
    if (left.pixels[index] !== right.pixels[index]) return false;
  }
  return true;
}
