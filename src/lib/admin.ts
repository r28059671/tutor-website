// Shared helpers for admin actions.
import { ActionError, type ActionAPIContext } from 'astro:actions';
import { env } from 'cloudflare:workers';
import { deleteObjects } from './storage';

export function requireAdmin(context: ActionAPIContext) {
  if (!context.locals.isAdmin) {
    throw new ActionError({ code: 'UNAUTHORIZED', message: 'Your session expired. Sign in again to continue.' });
  }
}

export function clientIp(context: ActionAPIContext): string {
  try {
    return context.clientAddress;
  } catch {
    return context.request.headers.get('cf-connecting-ip') ?? 'unknown';
  }
}

/** SQLite CURRENT_TIMESTAMP format, so app-written and default timestamps compare cleanly. */
export function sqlNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Delete stored objects that no lesson_files row references any more.
 * Keys are content-addressed, so the same PDF may back several lessons.
 * Failures are logged, never thrown: the DB is the source of truth.
 */
export async function deleteUnreferencedObjects(keys: string[]) {
  const unique = [...new Set(keys)];
  if (!unique.length) return;
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT r2_key AS key FROM lesson_files WHERE r2_key IN (${unique.map(() => '?').join(',')})`,
    )
      .bind(...unique)
      .all<{ key: string }>();
    const stillUsed = new Set(results.map((r) => r.key));
    const orphaned = unique.filter((k) => !stillUsed.has(k));
    if (orphaned.length) await deleteObjects(orphaned);
  } catch (err) {
    console.error('Storage cleanup failed for keys', unique, err);
  }
}

type Orderable = { table: 'subjects' | 'chapters' | 'lessons'; scopeColumn: 'track' | 'subject_id' | 'chapter_id' };

/** Move one row up or down among its siblings, rewriting positions to a dense 0..n sequence. */
export async function moveRow({ table, scopeColumn }: Orderable, id: number, direction: 'up' | 'down') {
  const row = await env.DB.prepare(`SELECT ${scopeColumn} AS scope FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ scope: string | number }>();
  if (!row) throw new ActionError({ code: 'NOT_FOUND', message: 'That item no longer exists.' });
  const { results } = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${scopeColumn} = ? ORDER BY position, id`)
    .bind(row.scope)
    .all<{ id: number }>();
  const ids = results.map((r) => r.id);
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await env.DB.batch(ids.map((rowId, i) => env.DB.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).bind(i, rowId)));
}

export async function nextPosition(table: Orderable['table'], scopeColumn: Orderable['scopeColumn'], scope: string | number) {
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${table} WHERE ${scopeColumn} = ?`)
    .bind(scope)
    .first<{ next: number }>();
  return row?.next ?? 0;
}
