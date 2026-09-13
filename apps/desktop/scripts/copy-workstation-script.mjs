// Legt deploy/windows/setup-workstation.ps1 neben den frisch gebauten Installer
// (apps/desktop/release), damit beides zusammen auf den Arbeitsplatz wandert.
// Läuft am Ende von `npm run dist:win`; ohne Installer-Build ist es ein No-op.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.resolve(here, '../../../deploy/windows/setup-workstation.ps1');
const outDir = path.resolve(here, '../release');
if (!fs.existsSync(outDir)) process.exit(0);
const dst = path.join(outDir, 'setup-workstation.ps1');
// CRLF: Windows PowerShell 5.1 liest .ps1 ohne BOM als ANSI; Zeilenenden wie
// im Release-Archiv (release-server.mjs normalisiert .ps1 ebenfalls auf CRLF).
const text = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(dst, text);
console.log(`setup-workstation.ps1 → ${path.relative(process.cwd(), dst)}`);
