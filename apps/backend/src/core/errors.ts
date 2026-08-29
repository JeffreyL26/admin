import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';

/**
 * Einheitliches Fehlerschema für alle Clients (Desktop heute, Web später):
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Nicht gefunden') => new AppError(404, 'NOT_FOUND', msg);
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', msg, details);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unauthorized = (msg = 'Nicht angemeldet') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Keine Berechtigung für diese Aktion') =>
  new AppError(403, 'FORBIDDEN', msg);

/** Validiert Request-Daten gegen ein Zod-Schema und wirft bei Fehlern das einheitliche Schema. */
/**
 * Eingabe ist bewusst `unknown` statt an den Ausgabetyp gekoppelt: Schemata mit
 * `.transform()` (z. B. kommagetrennte Filterlisten in Query-Parametern) haben
 * eine andere Ein- als Ausgabeform. Am Aufrufverhalten ändert das nichts.
 */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Eingabedaten sind ungültig', result.error.flatten());
  }
  return result.data;
}

export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Eingabedaten sind ungültig', details: error.flatten() },
    });
    return;
  }
  // JWT-Fehler (@fastify/jwt) einheitlich und deutsch ausgeben.
  if (error.code?.startsWith('FST_JWT')) {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Nicht angemeldet oder Sitzung abgelaufen' },
    });
    return;
  }
  // Grenzen des Multipart-Parsers (@fastify/multipart, konfiguriert in
  // server.ts). Ohne diese Zuordnung kommt beim Client ein nacktes 500
  // „Interner Serverfehler" an — verifiziert für FST_FIELDS_LIMIT bei
  // POST /api/files — und im Log liegt ein Stacktrace, obwohl es sich um
  // eine ganz normale, vom Nutzer verursachte Eingabegrenze handelt. Ein
  // 500 ist außerdem irreführend: Er lädt zum Wiederholen ein, was die Last
  // nur vervielfacht.
  const MULTIPART_LIMITS: Record<string, string> = {
    FST_REQ_FILE_TOO_LARGE: 'Die Datei ist zu groß',
    FST_FILES_LIMIT: 'Es kann nur eine Datei je Vorgang hochgeladen werden',
    FST_FIELDS_LIMIT: 'Das Formular enthält zu viele Felder',
    FST_PARTS_LIMIT: 'Das Formular enthält zu viele Teile',
    FST_FIELD_SIZE_LIMIT: 'Ein Formularfeld ist zu groß',
    FST_PROTO_VIOLATION: 'Das Formular enthält einen unzulässigen Feldnamen',
    FST_INVALID_MULTIPART_CONTENT_TYPE: 'Der Inhaltstyp der Anfrage ist kein gültiges Formular',
  };
  const multipartMessage = error.code ? MULTIPART_LIMITS[error.code] : undefined;
  if (multipartMessage) {
    // 413 nur für die reine Größengrenze, sonst 400: Bei zu vielen Feldern
    // oder Teilen ist nicht die Menge das Problem, sondern die Form.
    const status = error.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400;
    reply.status(status).send({
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: multipartMessage,
      },
    });
    return;
  }
  // SQLite-Constraint-Verletzungen als 409 statt 500 ausgeben.
  if (error.message?.includes('SQLITE_CONSTRAINT')) {
    reply.status(409).send({
      error: { code: 'CONFLICT', message: 'Der Datensatz verletzt eine Integritätsbedingung', details: error.message },
    });
    return;
  }
  const status = error.statusCode ?? 500;
  req.log.error(error);
  reply.status(status).send({
    error: {
      code: status === 500 ? 'INTERNAL_ERROR' : (error.code ?? 'ERROR'),
      message: status === 500 ? 'Interner Serverfehler' : error.message,
    },
  });
}
