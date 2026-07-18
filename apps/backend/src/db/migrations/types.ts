export interface Migration {
  /** Eindeutig, sortierbar, z. B. "100_employees_core". Nummernkreis siehe migrate.ts. */
  name: string;
  sql: string;
}
