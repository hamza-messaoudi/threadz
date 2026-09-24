// npm run gate:inventory -- --dir <path>
import path from 'node:path';
import { loadConfig } from '../config/load.ts';
import { resolvePaths } from '../paths.ts';
import { compileGate } from './compile.ts';
import { classifyInventory, readToolList } from './inventory.ts';

const i = process.argv.indexOf('--dir');
const dir = path.resolve(i >= 0 ? process.argv[i + 1] : process.cwd());
const cfg = loadConfig(resolvePaths().configDir);
const { tools, mcpServers } = await readToolList(cfg.config.claudeBin, dir);
console.log(`Directory: ${dir}`);
console.log(`MCP servers: ${mcpServers.map((s) => `${s.name} (${s.status})`).join(', ') || 'none'}\n`);
const rows = classifyInventory(tools, compileGate(cfg.readonly));
const w = Math.max(...rows.map((r) => r.tool.length));
for (const r of rows) console.log(`${r.allow ? 'allow' : 'DENY '}  ${r.tool.padEnd(w)}  ${r.rule}`);
console.log(`\n${rows.filter((r) => r.allow).length} allowed, ${rows.filter((r) => !r.allow).length} denied in read-only mode.`);
