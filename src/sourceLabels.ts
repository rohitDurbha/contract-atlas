import type { Overview, Source } from './types';

export interface SourceBadge { label: string; className: string }

const STATUS: Record<Source['status'], SourceBadge> = {
  healthy: { label: 'Connected', className: 'healthy' },
  blocked: { label: 'Access restricted', className: 'blocked' },
  needs_adapter: { label: 'Adapter needed', className: 'pending' },
  error: { label: 'Needs attention', className: 'blocked' },
  pending: { label: 'Not checked', className: 'pending' },
};

// The badge on a source card. A readable source with nothing in the feed says so
// plainly instead of claiming a complete or partial feed.
export function sourceBadge(source: Source): SourceBadge {
  if (source.empty) return { label: 'No open roles', className: 'no-roles' };
  if (source.status === 'healthy') return { label: source.coverage === 'complete' ? 'Complete feed' : 'Partial feed', className: 'healthy' };
  return STATUS[source.status] ?? STATUS.pending;
}

export interface DirectorySummary { total: number; complete: number; empty: number; providers: number; restricted: number }

// Counts for the tiles above the source directory. Complete feeds only include
// sources that have roles, matching the overview counts from the API.
export function directorySummary(sources: Source[]): DirectorySummary {
  return {
    total: sources.length,
    complete: sources.filter(s => s.status === 'healthy' && !s.empty && s.coverage === 'complete').length,
    empty: sources.filter(s => s.empty).length,
    providers: new Set(sources.map(s => s.provider)).size,
    restricted: sources.filter(s => s.status === 'blocked').length,
  };
}

export const ALL_PROVIDERS = 'All providers';

export interface DirectoryFilter { query: string; provider: string; showEmpty: boolean }

// Sources shown in the directory grid. Search matches the company or provider name,
// and sources with no open roles can be hidden so the grid only lists live feeds.
export function filterSources(sources: Source[], filter: DirectoryFilter): Source[] {
  const query = filter.query.trim().toLowerCase();
  return sources.filter(s =>
    (filter.provider === ALL_PROVIDERS || s.provider === filter.provider)
    && (filter.showEmpty || !s.empty)
    && `${s.company} ${s.provider}`.toLowerCase().includes(query));
}

type Counts = Pick<Overview, 'sourceCount' | 'healthySources' | 'completeSources' | 'partialSources' | 'emptySources'>;

// Subtitle under the readable sources metric on the home page.
export function readableSourcesNote(stats: Counts | undefined): string {
  if (!stats) return 'Checking sources';
  const base = `${stats.completeSources} of ${stats.sourceCount} fully retrieved`;
  return stats.emptySources ? `${base}, ${stats.emptySources} with no open roles` : base;
}

// The coverage notice on the home page, or null when every source was either fully
// retrieved or read successfully with no open roles. An empty source is not a gap.
export function coverageNotice(stats: Counts | undefined): string | null {
  if (!stats) return null;
  const accounted = stats.completeSources + stats.emptySources;
  if (accounted >= stats.sourceCount) return null;
  const parts = [`${stats.completeSources} of ${stats.sourceCount} feeds fully retrieved`];
  if (stats.partialSources) parts.push(`${stats.partialSources} more ${stats.partialSources === 1 ? 'has' : 'have'} partial results`);
  if (stats.emptySources) parts.push(`${stats.emptySources} ${stats.emptySources === 1 ? 'was' : 'were'} read but ${stats.emptySources === 1 ? 'has' : 'have'} no open roles right now`);
  const unread = stats.sourceCount - stats.healthySources - stats.emptySources;
  if (unread > 0) parts.push(`${unread} could not be read`);
  return `${parts.join(', ')}. A missing result may still be available on its original portal.`;
}
