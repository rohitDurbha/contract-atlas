import { SOURCES } from './sources.js';
import { retentionCutoff, PERMANENT_TYPES } from './policy.js';

export interface PruneResult { removedJobs: number; removedRuns: number }

// Keeps the committed snapshot small. Every refresh commits data/atlas.sqlite,
// so rows that can never appear in the feed again are deleted here.
export async function pruneSnapshot(db: D1Database, now = new Date()): Promise<PruneResult> {
  const active = SOURCES.map(() => '?').join(',');
  const ids = SOURCES.map(s => s.id);
  const cutoff = retentionCutoff(now).toISOString();
  // A role missing from its source for two weeks is treated as closed for good.
  const closed = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const permanent = PERMANENT_TYPES.map(() => '?').join(',');
  const [orphans, expired, stale, perm, runs] = await db.batch([
    db.prepare(`DELETE FROM jobs WHERE source_id NOT IN (${active}) RETURNING id`).bind(...ids),
    db.prepare('DELETE FROM jobs WHERE coalesce(posted_at,first_seen_at) < ? RETURNING id').bind(cutoff),
    db.prepare('DELETE FROM jobs WHERE active=0 AND last_seen_at < ? RETURNING id').bind(closed),
    db.prepare(`DELETE FROM jobs WHERE lower(trim(coalesce(json_extract(data,'$.employmentType'),''))) IN (${permanent}) RETURNING id`).bind(...PERMANENT_TYPES),
    db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT 50) RETURNING id'),
  ]);
  await db.prepare(`DELETE FROM source_coverage WHERE source_id NOT IN (${active})`).bind(...ids).run();
  const count = (r: any) => (r?.results ?? []).length;
  return { removedJobs: count(orphans) + count(expired) + count(stale) + count(perm), removedRuns: count(runs) };
}
