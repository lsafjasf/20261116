import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const files = (await readdir('tests'))
  .filter((name) => /^\d+.*\.(test|visual)\.mjs$/.test(name))
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n========== ${file} ==========`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [`tests/${file}`], { stdio: 'inherit' });
    child.on('exit', resolve);
  });
  if (code !== 0) failed += 1;
}

console.log(failed ? `\n${failed} 个测试文件失败` : '\n所有验收测试通过');
process.exit(failed ? 1 : 0);
