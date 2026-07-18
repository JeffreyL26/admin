import { startServer } from './server.js';
import { config } from './config.js';

startServer()
  .then(({ port }) => {
    console.log(`HRMONIC Backend läuft auf http://${config.host}:${port}`);
    console.log(`Datenverzeichnis: ${config.dataDir}`);
  })
  .catch((err) => {
    console.error('Backend-Start fehlgeschlagen:', err);
    process.exit(1);
  });
