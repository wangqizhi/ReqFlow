// Local development only. Never calls the hosted database.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const [command, input, flag] = process.argv.slice(2);
const schema = "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL, version INTEGER DEFAULT 0 NOT NULL);";
function execute(sql) {
  const temp = mkdtempSync(join(tmpdir(), "reqflow-local-"));
  try {
    const file = join(temp, "workspace.sql");
    writeFileSync(file, sql, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--persist-to", ".wrangler/state", "--file", file], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("本地数据库操作失败；未覆盖线上数据。");
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
try {
  if (command === "init") {
    execute(schema);
    console.log("本地数据库初始化完成。请运行 pnpm dev。");
  } else if (command === "import" && input && (!flag || flag === "--replace")) {
    const data = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(data.projects) || data.projects.some(p => typeof p.id !== "string" || typeof p.name !== "string" || !Array.isArray(p.items) || !Array.isArray(p.batches))) throw new Error("请使用 ReqFlow 导出的完整工作区 JSON。");
    const literal = JSON.stringify(data).replaceAll("'", "''");
    const conflict = flag === "--replace" ? " ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=workspaces.version+1" : "";
    execute(schema + "\nINSERT INTO workspaces (id,data,version) VALUES ('local_seedy','" + literal + "',0)" + conflict + ";");
    console.log("导入完成：" + data.projects.length + " 个项目。启动开发服务器并刷新页面。");
  } else throw new Error("用法：pnpm local:init 或 pnpm local:import <备份.json> [--replace]。已有工作区时，只有 --replace 会覆盖。");
} catch (error) { console.error(error.message); process.exitCode = 1; }
