// 三种织物图案。warpColor(i, pick) 返回第 i 根经纱在第 pick 次投梭时的颜色，
// shedUp(i, pick) 决定该经纱是否位于梭口上层（张力更高）。
export const PATTERNS = {
  plain: {
    id: 'plain',
    name: '平纹',
    warpCount: 16,
    rowWidthCm: 0.05,
    colors: {
      a: '#d94f4f',
      b: '#3f6fd1',
      weft: '#f2e3c6',
    },
    shedUp(i, pick) {
      return (i + pick) % 2 === 0;
    },
    warpColor(i, pick) {
      return (i + pick) % 2 === 0 ? 'a' : 'b';
    },
  },
  twill: {
    id: 'twill',
    name: '2/2 斜纹',
    warpCount: 16,
    rowWidthCm: 0.05,
    colors: {
      a: '#2f8f5b',
      b: '#e0b63c',
      weft: '#efe7d4',
    },
    shedUp(i, pick) {
      return ((i - pick) % 4 + 4) % 4 < 2;
    },
    warpColor(i, pick) {
      return ((i - pick) % 4 + 4) % 4 < 2 ? 'a' : 'b';
    },
  },
  satin: {
    id: 'satin',
    name: '五枚缎纹',
    warpCount: 16,
    rowWidthCm: 0.05,
    colors: {
      a: '#7a4cc2',
      b: '#d86fa8',
      weft: '#f4ead9',
    },
    shedUp(i, pick) {
      // 每 5 根只有 1 根下沉，其余上浮，形成长浮线的缎面。
      return ((i - pick * 2) % 5 + 5) % 5 !== 0;
    },
    warpColor(i, pick) {
      return ((i - pick * 2) % 5 + 5) % 5 !== 0 ? 'a' : 'b';
    },
  },
};

export function getPattern(id) {
  const pattern = PATTERNS[id];
  if (!pattern) throw new Error(`未知图案: ${id}`);
  return pattern;
}
