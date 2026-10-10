// 数据目录解析 —— GUI 与 CLI 共用。
// 优先级：REQFLOW_DATA_DIR 环境变量 > 便携版 exe 同级 data\ > 安装版 data-dir.cfg > %APPDATA%\ReqFlow（开发模式）
// - 便携版：electron-builder 启动器设置 PORTABLE_EXECUTABLE_DIR 指向 exe 所在目录，数据跟随 exe
// - 安装版：安装向导（build/installer.nsh）把所选目录写入安装目录下 data-dir.cfg（UTF-16LE 带 BOM）

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const INSTALL_MARKER = 'data-dir.cfg';

export function resolveDataDir(): string {
  const override = process.env.REQFLOW_DATA_DIR;
  if (override) return override;

  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) return path.join(portableDir, 'data');

    const marker = readInstallMarker(path.join(path.dirname(process.execPath), INSTALL_MARKER));
    if (marker) return marker;
  }

  return app.getPath('userData');
}

function readInstallMarker(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    const off = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
    const dir = buf.slice(off).toString('utf16le').trim();
    return dir || null;
  } catch {
    return null;
  }
}
