import { contextBridge, ipcRenderer } from 'electron';

// Der API-Port wird vom Main-Prozess deterministisch via additionalArguments
// übergeben (im Prod-Betrieb ist es ein zufälliger freier Port).
const apiArg = process.argv.find((a) => a.startsWith('--hrmonic-api-base='));
const apiBaseUrl = apiArg?.split('=')[1] ?? 'http://127.0.0.1:3001';

contextBridge.exposeInMainWorld('hrmonic', {
  apiBaseUrl,
  platform: process.platform,
  appVersion: process.env.npm_package_version ?? '1.0.0',
  onMenuNavigate: (callback: (route: string) => void) => {
    const listener = (_event: unknown, route: string) => callback(route);
    ipcRenderer.on('menu:navigate', listener);
    return () => ipcRenderer.removeListener('menu:navigate', listener);
  },
});
