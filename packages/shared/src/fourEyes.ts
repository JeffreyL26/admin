/**
 * Vier-Augen-Prinzip: wann ein Konto einen Antrag nicht genehmigen darf.
 *
 * Eine Quelle fuer die Pruefung im Backend (Abwesenheit:
 * absences/service.ts#assertNotOwnEmployee, Gehalt: compensation/salaryRoutes.ts,
 * Stammdaten: employees/changeRequestService.ts) und fuer die Anzeige im
 * Dashboard (rote Quadrate, gesperrte Knoepfe). Wer eine Regel aendert, aendert
 * sie hier, sonst zaehlt das Dashboard still falsch.
 * Test: apps/backend/src/test/dashboardLogicTest.ts.
 */

const known = (id: number | null | undefined): id is number => id !== null && id !== undefined;

/** Antrag betrifft das eigene Personalprofil (Abwesenheit, Stammdaten). */
export function isOwnPersonDecision(
  actorEmployeeId: number | null | undefined,
  subjectEmployeeId: number | null | undefined,
): boolean {
  return known(actorEmployeeId) && known(subjectEmployeeId) && actorEmployeeId === subjectEmployeeId;
}

/** Antrag wurde von diesem Konto gestellt (Gehalt, Stammdaten). */
export function isOwnRequestDecision(
  actorUserId: number | null | undefined,
  requestedByUserId: number | null | undefined,
): boolean {
  return known(actorUserId) && known(requestedByUserId) && actorUserId === requestedByUserId;
}
