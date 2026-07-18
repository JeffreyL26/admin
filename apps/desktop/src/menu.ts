import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

interface MenuHooks {
  isDev: boolean;
  navigate: (route: string) => void;
  about: () => void;
}

/** Natives deutsches Anwendungsmenü mit Tastaturkürzeln. */
export function buildMenu({ isDev, navigate, about }: MenuHooks): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }]
      : []),
    {
      label: '&Datei',
      submenu: [
        {
          label: 'Neuer Mitarbeiter …',
          accelerator: 'CmdOrCtrl+N',
          click: () => navigate('/personal/mitarbeitende?neu=1'),
        },
        {
          label: 'Neuer Abwesenheitsantrag …',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => navigate('/abwesenheit/antraege?neu=1'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Fenster schließen' } : { role: 'quit', label: 'Beenden', accelerator: 'Alt+F4' },
      ],
    },
    {
      label: '&Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Rückgängig' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: '&Navigation',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => navigate('/dashboard') },
        { label: 'Mitarbeitende', accelerator: 'CmdOrCtrl+2', click: () => navigate('/personal/mitarbeitende') },
        { label: 'Abwesenheitskalender', accelerator: 'CmdOrCtrl+3', click: () => navigate('/abwesenheit/kalender') },
        { label: 'Ziele & OKR', accelerator: 'CmdOrCtrl+4', click: () => navigate('/leistung/ziele') },
        { label: 'Gehälter', accelerator: 'CmdOrCtrl+5', click: () => navigate('/verguetung/gehaelter') },
        { label: 'Ankündigungen', accelerator: 'CmdOrCtrl+6', click: () => navigate('/kommunikation/ankuendigungen') },
        { type: 'separator' },
        { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: () => navigate('/einstellungen') },
      ],
    },
    {
      label: '&Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        ...(isDev ? [{ role: 'toggleDevTools' as const, label: 'Entwicklertools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom zurücksetzen' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
    {
      label: '&Hilfe',
      submenu: [
        {
          label: 'HRMONIC-Dokumentation',
          click: () => shell.openExternal('https://hrmonic.de/docs'),
        },
        { type: 'separator' },
        { label: 'Über HRMONIC', click: about },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
