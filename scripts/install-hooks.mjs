#!/usr/bin/env node
/**
 * Aktiviert die versionierten Git-Hooks (.githooks): setzt core.hooksPath
 * dieses Repositories. Laeuft als `prepare` bei `npm install`/`npm ci`; ohne
 * Git-Arbeitskopie (Archiv, CI-Kopie) tut es nichts und scheitert nie.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.git')) && fs.existsSync(path.join(root, '.githooks'))) {
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
}
