// 用法: node scripts/export-demo.js [输出目录]
// 导出前自动保留工程快照，并对导出结果做重载一致性校验
import { join, resolve } from 'node:path';
import { exportProject } from '../src/core/exporter.js';
import { buildDemoScene } from '../src/core/demo.js';

const outDir = resolve(process.argv[2] ?? join('artifacts', 'exports'));
const root = buildDemoScene();
const result = exportProject(root, outDir, {
  stamp: 'demo',
  width: 480,
  height: 360,
  background: '#f4f6fa',
  clock: new Date().toISOString(),
});

console.log('导出完成:');
Object.entries(result.manifest.files).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('重载校验:', JSON.stringify(result.manifest.reloadChecks));
if (!result.manifest.reloadChecks.passed) {
  process.exitCode = 1;
}
