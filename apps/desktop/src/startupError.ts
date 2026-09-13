/**
 * Startabbruch mit einer für Nutzer gedachten Meldung. Der Fehlerdialog zeigt
 * für diese Klasse nur den Text: Ein nicht erreichbarer oder zu alter Server
 * ist kein Absturz, sondern ein Zustand, den der Satz erklären muss — ein
 * Stacktrace davor macht ihn für die Person am Arbeitsplatz unlesbar.
 *
 * Eigene Datei, weil neben main.ts auch das Schlüssel-Pinning
 * (serverPinning.ts) Startabbrüche mit Klartext auslöst.
 */
export class StartupError extends Error {}
