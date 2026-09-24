import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ReadonlyConfig } from '../config/types.ts';
import { appRoot } from '../paths.ts';
import type { GateConfig } from './classify.ts';

export function defaultGate(): GateConfig {
  const d = YAML.parse(fs.readFileSync(path.join(appRoot, 'server', 'gate', 'readonly.default.yaml'), 'utf8'));
  return {
    builtinAllow: d.builtin.allow ?? [],
    builtinDeny: d.builtin.deny ?? [],
    servers: d.servers ?? {},
    allow: d.allow ?? [],
    deny: d.deny ?? [],
    bashExtraAllow: d.bash?.extraAllow ?? [],
  };
}

/** Merges readonly.yaml into the built-in defaults. */
export function compileGate(user: ReadonlyConfig): GateConfig {
  const d = defaultGate();
  return {
    ...d,
    servers: { ...d.servers, ...user.servers },
    allow: [...d.allow, ...user.allow],
    deny: [...d.deny, ...user.deny],
    bashExtraAllow: [...d.bashExtraAllow, ...user.bash.extraAllow],
  };
}

/** Writes gate.json atomically so the hook never reads a half-written file. */
export function writeGate(file: string, gate: GateConfig): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(gate, null, 2));
  fs.renameSync(tmp, file);
}
