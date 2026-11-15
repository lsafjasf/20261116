/*
 * Node 端核心管线测试：node test/pipeline.test.mjs
 * 验证：分块==单次、顺序影响像素、噪点确定性、恒等链、模糊与朴素参考一致。
 */
import '../js/pipeline.js';
import '../js/images.js';

const PC = globalThis.PipelineCore;
const IMG = globalThis.TestImages;
const yieldUI = async () => {};

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

const nodes = [
  { id: 'n1', type: 'levels', enabled: true, params: { inBlack: 20, inWhite: 235, gamma: 1.25, outBlack: 0, outWhite: 255 } },
  { id: 'n2', type: 'noise', enabled: true, params: { amount: 24, seed: 42, mono: false } },
  { id: 'n3', type: 'blur', enabled: true, params: { radius: 4 } },
  { id: 'n4', type: 'tonemap', enabled: true, params: { exposure: 1.35, operator: 'filmic' } }
];

async function run(image, nodeList, tileH) {
  const r = new PC.Runner(image.width, image.height, nodeList, tileH);
  r.setSource(image.data);
  await r.process(null, yieldUI);
  return PC.hashPixels(r.finalBuffer());
}

const img = IMG.generators.gradient(320, 200);

// 1) 分块结果与单次整图一致（tileH = 1, 7, 64, 全高）
const whole = await run(img, nodes, img.height);
for (const t of [1, 7, 64, 113]) {
  const h = await run(img, nodes, t);
  check(`分块 tileH=${t} == 单次`, h === whole, h.slice(0, 12));
}

// 2) 节点顺序真实改变像素
const reordered = JSON.parse(JSON.stringify(nodes));
[reordered[1], reordered[2]] = [reordered[2], reordered[1]]; // noise <-> blur
const hB = await run(img, reordered, 64);
check('noise→blur 与 blur→noise 哈希不同', hB !== whole, `${whole.slice(0, 12)} vs ${hB.slice(0, 12)}`);

// 3) 确定性：同参数两次运行哈希相同
const again = await run(img, nodes, 64);
check('同参数重算哈希稳定', again === whole);

// 4) 三张程序图两两顺序哈希均不同
for (const name of ['gradient', 'checker', 'radial']) {
  const im = IMG.generators[name](160, 120);
  const a = await run(im, nodes, 32);
  const b = await run(im, reordered, 32);
  check(`图 ${name} 顺序敏感`, a !== b);
}

// 5) 恒等链（零模糊/零噪/默认色阶/停用色调映射）输出 == 输入
const tiny = IMG.generators.tiny();
const identity = [
  { id: 'a', type: 'levels', enabled: true, params: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } },
  { id: 'b', type: 'blur', enabled: true, params: { radius: 0 } },
  { id: 'c', type: 'noise', enabled: true, params: { amount: 0, seed: 1 } },
  { id: 'd', type: 'tonemap', enabled: false, params: { exposure: 1, operator: 'reinhard' } }
];
const idHash = await run(tiny, identity, 1);
const srcHash = await PC.hashPixels(tiny.data);
check('2x2 恒等链 == 源', idHash === srcHash);

// 6) 模糊与朴素参考实现逐像素一致（半径 3，含边界钳制）
{
  const im = IMG.generators.checker(37, 23);
  const r = 3;
  const ref = new Uint8ClampedArray(im.data.length);
  const clamp = (v, m) => (v < 0 ? 0 : v >= m ? m - 1 : v);
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = clamp(y + dy, im.height), xx = clamp(x + dx, im.width);
            acc += im.data[(yy * im.width + xx) * 4 + c]; n++;
          }
        }
        ref[(y * im.width + x) * 4 + c] = acc / n;
      }
      ref[(y * im.width + x) * 4 + 3] = 255;
    }
  }
  const out = new Uint8ClampedArray(im.data.length);
  const tmp = new Uint8ClampedArray(im.data.length);
  PC.applyBlur(im.data, tmp, out, im.width, im.height, 0, im.height, { radius: r });
  let maxDiff = 0;
  for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]));
  check('可分离盒模糊 == 朴素参考 (±1)', maxDiff <= 1, `maxDiff=${maxDiff}`);
}

// 7) 噪点确定性与坐标依赖（与分块无关）
{
  const a = PC.pixelHash(10, 20, 7);
  const b = PC.pixelHash(10, 20, 7);
  const c = PC.pixelHash(11, 20, 7);
  check('pixelHash 确定性且随坐标变化', a === b && a !== c);
}

// 8) 局部脏区域：只重算受影响行带，且结果与全量一致
{
  const im = IMG.generators.gradient(120, 90);
  const r1 = new PC.Runner(im.width, im.height, JSON.parse(JSON.stringify(nodes)), 16);
  r1.setSource(im.data);
  await r1.process(null, yieldUI);
  // 模拟局部编辑：改源图一个矩形，再从节点0局部失效
  for (let y = 30; y < 40; y++) for (let x = 30; x < 40; x++) {
    const i = (y * im.width + x) * 4;
    r1.src[i] = 255; r1.src[i + 1] = 0; r1.src[i + 2] = 0;
  }
  r1.invalidateFrom(0, { x0: 30, y0: 30, x1: 40, y1: 40 });
  await r1.process(null, yieldUI);
  const partialTiles = r1.stats.tiles;
  // 全量参考
  const r2 = new PC.Runner(im.width, im.height, JSON.parse(JSON.stringify(nodes)), 16);
  r2.setSource(r1.src);
  await r2.process(null, yieldUI);
  const h1 = await PC.hashPixels(r1.finalBuffer());
  const h2 = await PC.hashPixels(r2.finalBuffer());
  check('局部重算 == 全量重算', h1 === h2, `分块=${partialTiles} < ${Math.ceil(90 / 16)}`);
  check('局部重算分块数更少', partialTiles < Math.ceil(90 / 16));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
