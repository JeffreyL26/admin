/**
 * Varianten: Land x Edition als eigener Build.
 *
 * Das Register (registry.json, daneben) ist die einzige Quelle: Welche
 * Varianten es gibt, wie sie heissen und welche Module sie enthalten, legt
 * der Anbieter dort fest. Editionen sind KEINE feste Liste im Code; der
 * Schluessel muss nur dem Muster folgen (country.ts EDITION_PATTERN).
 *
 * Aus dem Register erzeugt `npm run variants:gen` (scripts/variant-wiring.mjs)
 * je App die Verdrahtungsdateien `src/variants/<id>.ts`, die nur die Module
 * der Variante statisch importieren. Der Build zeigt den Alias `@variant`
 * (und `@variant-manifest` fuer Dateien, die nur das Manifest brauchen) per
 * OHRGANIZE_VARIANT auf die passende Datei; im Dev-Betrieb und beim Typecheck
 * gilt die Vorgabe (`default`). Code ausgeschlossener Module wird nicht
 * importiert und landet deshalb nicht im Bundle.
 *
 * Das Datenbankschema ist in allen Varianten identisch: Editionen entfernen
 * Routen und Seiten, keine Tabellen. Ein Wechsel der Edition ist Installer
 * plus Lizenz, ohne Migration.
 */
import type { AdminArea } from '../admin.js';
import { COUNTRY_CODES, EDITION_PATTERN, type CountryCode, type Edition } from '../country.js';
import registry from './registry.json';

/** Fachmodule, die eine Variante ein- oder ausschliessen kann. */
export const MODULE_KEYS = [
  'employees',
  'absences',
  'performance',
  'leadership',
  'compensation',
  'communication',
  'recruiting',
  'admin',
  'me',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  employees: 'Personal',
  absences: 'Abwesenheit',
  performance: 'Leistung',
  leadership: 'Führung',
  compensation: 'Vergütung',
  communication: 'Kommunikation',
  recruiting: 'Recruiting',
  admin: 'Verwaltung und Benutzer',
  me: 'Mitarbeitenden-Portal',
};

/**
 * Rechtebereich -> Modul. Damit Navigation, Dashboard und Palette einen
 * Bereich ausblenden koennen, dessen Modul im Build fehlt. null: Bereich
 * ohne Modulbindung (Einstellungen gibt es in jeder Variante).
 */
export const AREA_MODULES: Record<AdminArea, ModuleKey | null> = {
  personal: 'employees',
  abwesenheit: 'absences',
  leistung: 'performance',
  fuehrung: 'leadership',
  verguetung: 'compensation',
  recruiting: 'recruiting',
  kommunikation: 'communication',
  verwaltung: 'admin',
  einstellungen: null,
  benutzer: 'admin',
};

/** Ist das Modul in der Variante enthalten? undefined/null = keine Modulbindung = immer. */
export function moduleEnabled(variant: Pick<VariantManifest, 'modules'>, module: ModuleKey | null | undefined): boolean {
  return module === null || module === undefined || variant.modules.includes(module);
}

/**
 * Module, ohne die keine Variante funktioniert: Personalprofile sind die
 * Grundlage aller anderen Module, und die Verwaltung enthaelt Benutzer und
 * Rechte (ohne sie gaebe es keine Konten).
 */
export const REQUIRED_MODULES: readonly ModuleKey[] = ['employees', 'admin'];

/**
 * Fachliche Abhaengigkeiten: Das Portal stellt Abwesenheitsantraege, seine
 * Routen liegen im Modul `me`; ohne `absences` gaebe es nichts zu genehmigen.
 */
export const MODULE_DEPENDENCIES: Partial<Record<ModuleKey, readonly ModuleKey[]>> = {
  me: ['absences'],
};

export interface VariantManifest {
  /** `<land>-<edition>`, z. B. `de-vollversion`. */
  id: string;
  country: CountryCode;
  edition: Edition;
  /** Anzeigename (Ueber-Dialog, Titelleiste, Lizenzseite, Installername im Klartext). */
  label: string;
  modules: readonly ModuleKey[];
}

export const VARIANT_ID_PATTERN = /^[a-z]{2}-[a-z][a-z0-9-]{0,31}$/;

/** Zeichenkette, die jedes Bundle einer Variante traegt (scripts/check-variant.mjs). */
export function variantMarker(id: string): string {
  return `OHRGANIZE_VARIANT:${id}`;
}

interface RegistryFile {
  default: string;
  variants: {
    id: string;
    country: string;
    edition: string;
    label: string;
    modules: string[];
  }[];
}

function validate(file: RegistryFile): { variants: VariantManifest[]; defaultId: string } {
  const seen = new Set<string>();
  const variants: VariantManifest[] = [];
  for (const raw of file.variants) {
    const where = `Variante "${raw.id}"`;
    if (!VARIANT_ID_PATTERN.test(raw.id)) throw new Error(`${where}: id muss <land>-<edition> sein (Kleinbuchstaben).`);
    if (seen.has(raw.id)) throw new Error(`${where}: id doppelt.`);
    seen.add(raw.id);
    if (!(COUNTRY_CODES as readonly string[]).includes(raw.country)) {
      throw new Error(`${where}: country muss ${COUNTRY_CODES.join(', ')} sein.`);
    }
    if (!EDITION_PATTERN.test(raw.edition)) throw new Error(`${where}: edition passt nicht zum Muster.`);
    if (raw.id !== `${raw.country.toLowerCase()}-${raw.edition}`) {
      throw new Error(`${where}: id muss "${raw.country.toLowerCase()}-${raw.edition}" lauten.`);
    }
    if (!raw.label.trim()) throw new Error(`${where}: label fehlt.`);
    const modules = raw.modules as ModuleKey[];
    for (const m of modules) {
      if (!(MODULE_KEYS as readonly string[]).includes(m)) throw new Error(`${where}: unbekanntes Modul "${m}".`);
    }
    if (new Set(modules).size !== modules.length) throw new Error(`${where}: Modul doppelt.`);
    for (const m of REQUIRED_MODULES) {
      if (!modules.includes(m)) throw new Error(`${where}: Modul "${m}" ist Pflicht.`);
    }
    for (const m of modules) {
      for (const dep of MODULE_DEPENDENCIES[m] ?? []) {
        if (!modules.includes(dep)) throw new Error(`${where}: Modul "${m}" braucht "${dep}".`);
      }
    }
    variants.push({
      id: raw.id,
      country: raw.country as CountryCode,
      edition: raw.edition,
      label: raw.label.trim(),
      // Reihenfolge wie MODULE_KEYS, damit erzeugte Dateien stabil bleiben.
      modules: MODULE_KEYS.filter((m) => modules.includes(m)),
    });
  }
  if (variants.length === 0) throw new Error('Variantenregister: keine Variante definiert.');
  if (!seen.has(file.default)) throw new Error(`Variantenregister: default "${file.default}" existiert nicht.`);
  return { variants, defaultId: file.default };
}

const parsed = validate(registry as RegistryFile);

/** Alle Varianten des Registers, in Registerreihenfolge. */
export const VARIANTS: readonly VariantManifest[] = parsed.variants;
export const VARIANT_IDS: readonly string[] = VARIANTS.map((v) => v.id);
/** Variante fuer Dev-Betrieb, Typecheck und Builds ohne OHRGANIZE_VARIANT. */
export const DEFAULT_VARIANT_ID: string = parsed.defaultId;

export function variantById(id: string): VariantManifest {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`Unbekannte Variante "${id}". Bekannt: ${VARIANT_IDS.join(', ')}.`);
  return v;
}

export function isVariantId(id: unknown): id is string {
  return typeof id === 'string' && VARIANT_IDS.includes(id);
}

/** `de-vollversion` -> { country: 'DE', edition: 'vollversion' }; null bei fremdem Muster. */
export function parseVariantId(id: string): { country: CountryCode; edition: Edition } | null {
  const m = /^([a-z]{2})-(.+)$/.exec(id);
  if (!m) return null;
  const country = m[1].toUpperCase();
  if (!(COUNTRY_CODES as readonly string[]).includes(country)) return null;
  if (!EDITION_PATTERN.test(m[2])) return null;
  return { country: country as CountryCode, edition: m[2] };
}

/** Variante zu Land und Edition (z. B. aus einer Lizenz); null, wenn das Register sie nicht kennt. */
export function variantFor(country: string, edition: string): VariantManifest | null {
  return VARIANTS.find((v) => v.country === country && v.edition === edition) ?? null;
}

/** Anzeigename fuer Land und Edition, auch wenn das Register die Kombination nicht kennt. */
export function variantLabelFor(country: string, edition: string, countryLabel: string): string {
  return variantFor(country, edition)?.label ?? `${countryLabel} ${edition}`;
}
