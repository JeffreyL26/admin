import { contextBridge, ipcRenderer } from 'electron';

// Der API-Port wird vom Main-Prozess deterministisch via additionalArguments
// übergeben (im Prod-Betrieb ist es ein zufälliger freier Port).
const apiArg = process.argv.find((a) => a.startsWith('--ohrganize-api-base='));
const apiBaseUrl = apiArg?.split('=')[1] ?? 'http://127.0.0.1:3001';

// Ebenso deterministisch vom Main-Prozess (app.getVersion()). Vorher stand hier
// process.env.npm_package_version — das ist ausschließlich im Dev-Betrieb
// gesetzt: In der installierten App griff still der Rückfallwert, sodass jede
// Version sich als 1.0.0 ausgab. Für den Versionsabgleich mit dem Server wäre
// das genau die falsche Auskunft. slice statt split('='), weil die Basis-URL
// selbst ein '=' enthalten kann.
const VERSION_ARG = '--ohrganize-app-version=';
const appVersion = process.argv.find((a) => a.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '0.0.0';

contextBridge.exposeInMainWorld('ohrganize', {
  apiBaseUrl,
  platform: process.platform,
  appVersion,

  // Fenster-Controls der eigenen Titelleiste.
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizeChange: (cb: (max: boolean) => void) => {
      const l = (_e: unknown, max: boolean) => cb(max);
      ipcRenderer.on('window:maximized-changed', l);
      return () => ipcRenderer.removeListener('window:maximized-changed', l);
    },
    onFullscreenChange: (cb: (fs: boolean) => void) => {
      const l = (_e: unknown, fs: boolean) => cb(fs);
      ipcRenderer.on('window:fullscreen-changed', l);
      return () => ipcRenderer.removeListener('window:fullscreen-changed', l);
    },
  },

  // App-Aktionen des Titelleisten-Menüs (früher das native Menü).
  app: {
    reload: () => ipcRenderer.send('app:reload'),
    toggleDevTools: () => ipcRenderer.send('app:toggle-devtools'),
    toggleFullscreen: () => ipcRenderer.send('app:toggle-fullscreen'),
    zoom: (delta: number) => ipcRenderer.send('app:zoom', delta),
    openExternal: (url: string) => ipcRenderer.send('app:open-external', url),
  },
});
