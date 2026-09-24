import { execSync } from 'node:child_process';
import fs from 'node:fs';

export default function setup() {
  // The gate hook runs as a standalone bundle; build it once for tests that spawn fake Claude.
  if (fs.existsSync('server/gate/hook.ts')) execSync('npm run -s build:hook', { stdio: 'inherit' });
}
