// 确定性像素哈希：WebGL 同参数渲染结果应逐位一致（无随机抖动）。
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function shortHash(hex, len = 12) {
  return hex.slice(0, len);
}

// 地形遮挡掩码差异：返回不一致像素占比（0~1）。
export function maskDiff(a, b) {
  const n = Math.min(a.pixels.length, b.pixels.length);
  let mismatch = 0;
  let total = 0;
  for (let i = 0; i < n; i += 4) {
    const va = a.pixels[i] > 127 ? 1 : 0;
    const vb = b.pixels[i] > 127 ? 1 : 0;
    if (va !== vb) mismatch += 1;
    total += 1;
  }
  return total ? mismatch / total : 1;
}

export function meanAbsoluteError(a, b) {
  const n = Math.min(a.pixels.length, b.pixels.length);
  let sum = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(a.pixels[i] - b.pixels[i]);
    total += 1;
  }
  return total ? sum / total : 0;
}

export async function frameHash(engine) {
  const frame = engine.readPixels('color');
  const hex = await sha256Hex(frame.pixels);
  return { hex, ...frame };
}
