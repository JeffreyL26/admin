/**
 * Prueft die Reihenfolge der Geschwister im Personen-Organigramm
 * (buildOrgModel in @ohrganize/shared/orgChart.ts), die Desktop-App und
 * Portal teilen: Zweige vor Blaettern, darin nach Abteilung gruppiert (die
 * Abteilung der leitenden Person zuerst, dann alphabetisch, ohne Abteilung
 * zuletzt) und je Abteilung nach Nachnamen.
 *
 * Aufruf: tsx src/test/orgChartTest.ts (Teil von npm test)
 */
import { buildOrgModel, type OrgChartBasePerson } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const departments = [
  { id: 1, name: 'Vertrieb' },
  { id: 2, name: 'Technik' },
  { id: 3, name: 'Marketing' },
];
const dept = (id: number | null) => (id === null ? null : departments.find((d) => d.id === id)!.name);
let nextId = 1;
const person = (last: string, departmentId: number | null, parent: number | null): OrgChartBasePerson => ({
  id: nextId++,
  first_name: 'X',
  last_name: last,
  job_title: null,
  department_id: departmentId,
  department_name: dept(departmentId),
  team_name: null,
  location_name: null,
  parent_id: parent,
  parent_source: parent === null ? null : 'manager',
});

// Leitung in Vertrieb, leitet zusaetzlich Technik und Marketing.
const boss = person('Zentral', 1, null);
const people = [
  boss,
  person('Weber', 2, boss.id),
  person('Adler', 2, boss.id),
  person('Neumann', 1, boss.id),
  person('Becker', 1, boss.id),
  person('Ohne', null, boss.id),
  person('Kunz', 3, boss.id),
];
const model = buildOrgModel({ people, departments });
const order = model.byId.get(boss.id)!.children.map((c) => c.person.last_name);
check(
  'eigene Abteilung zuerst, dann alphabetisch, ohne Abteilung zuletzt, je Abteilung nach Nachnamen',
  order.join() === 'Becker,Neumann,Kunz,Adler,Weber,Ohne',
  order,
);

// Zweige (mit eigenen Berichtenden) stehen weiter vor den Blaettern, auch
// wenn ihre Abteilung spaeter kaeme.
const head = person('Leitung', 2, null);
const lead = person('Teamlead', 3, head.id);
const leaf = person('Aaron', 2, head.id);
const sub = person('Unten', 3, lead.id);
const model2 = buildOrgModel({ people: [head, lead, leaf, sub], departments });
const order2 = model2.byId.get(head.id)!.children.map((c) => c.person.last_name);
check('Zweige vor Blaettern', order2.join() === 'Teamlead,Aaron', order2);

if (failures > 0) {
  console.log(`orgChartTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('orgChartTest: alle Pruefungen bestanden');
