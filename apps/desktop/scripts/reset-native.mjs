// Entfernt den Build-Ordner von better-sqlite3 vor dem Packaging.
//
// Hintergrund: electron-builder markiert umgebaute native Module mit
// build/Release/.forge-meta und überspringt den Electron-ABI-Umbau, wenn der
// Marker existiert. Ein zwischenzeitliches `npm rebuild better-sqlite3`
// (Node-ABI für Dev/Tests) tauscht aber nur die .node-Datei und lässt den
// Marker stehen — der nächste Installer würde dann die falsche ABI einpacken
// und die App startet mit NODE_MODULE_VERSION-Fehler. Deshalb: vor jedem
// dist den Ordner löschen, electron-builder baut dann garantiert frisch.
import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.join(
  import.meta.dirname,
  '../../../node_modules/better-sqlite3/build',
);

if (fs.existsSync(buildDir)) {
  fs.rmSync(buildDir, { recursive: true, force: true });
  console.log('better-sqlite3/build entfernt — electron-builder baut die Electron-ABI frisch.');
} else {
  console.log('better-sqlite3/build existiert nicht — nichts zu tun.');
}
