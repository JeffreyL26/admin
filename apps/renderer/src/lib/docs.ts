/**
 * Die Dokumentation: EINE Aktion fuer Titelleisten-Menue, Meldung nach dem
 * Ueberspringen und jede weitere Stelle, die darauf verweist. Im Desktop oeffnet
 * sie den Standardbrowser, im Browser einen neuen Tab.
 */
export const DOCS_URL = 'https://www.ohrganize.com/docs';

export function openDocs(): void {
  if (window.ohrganize?.app?.openExternal) window.ohrganize.app.openExternal(DOCS_URL);
  else window.open(DOCS_URL, '_blank');
}
