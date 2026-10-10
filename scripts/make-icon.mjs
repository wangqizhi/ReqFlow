// 从透明圆角薄荷色流程箭头母版生成 Windows 多尺寸图标和应用内图标。
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pngToIco from 'png-to-ico';
import pngTools from 'png-to-ico/lib/png.js';
import pngjs from 'pngjs';

const buildDir = path.resolve('build');
const publicDir = path.resolve('src/renderer/public');
const source = await pngTools.readPNG(path.join(buildDir, 'icon-source.png'));
if (source.width !== source.height || source.width < 256) {
  throw new Error('图标母版必须是至少 256px 的方形 PNG');
}
const encode = (size) => pngjs.PNG.sync.write(pngTools.resize(source, size, size));
const sizes = [16, 24, 32, 48, 64, 128, 256];
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(buildDir, 'icon.png'), encode(256));
await writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(sizes.map(encode)));
await writeFile(path.join(publicDir, 'app-icon.png'), encode(128));
console.log(`图标已生成：build/icon.png（256px）、build/icon.ico（${sizes.join('/')}px）、app-icon.png（128px）`);
