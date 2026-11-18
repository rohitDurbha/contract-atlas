import { describe, it, expect } from 'vitest';
import { ALL_PROVIDERS, coverageNotice, directorySummary, filterSources, readableSourcesNote, sourceBadge } from '../src/sourceLabels';
import { sourceHealth } from '../server/db';
import type { Source } from '../src/types';

const source = (over: Partial<Source>): Source => ({
  id: over.id ?? 'acme', company: 'Acme', provider: 'Workday', url: 'https://example.com', country: 'US',
  status: 'healthy', lastCheckedAt: null, lastSuccessAt: null, jobCount: 3, message: null,
  coverage: 'complete', empty: false, advertisedCount: null, fetchedCount: null, ...over,
});

const sources: Source[] = [
  source({ id: 'a' }),
  source({ id: 'b', coverage: 'partial', provider: 'Greenhouse' }),
  source({ id: 'c', jobCount: 0, empty: true }),
  source({ id: 'd', status: 'blocked', coverage: 'unavailable', jobCount: 0 }),
];

const overview = (list: Source[]) => {
  const h = sourceHealth(list);
  return { sourceCount: h.total, healthySources: h.healthy, completeSources: h.complete, partialSources: h.partial, emptySources: h.empty };
};

describe('source directory labels', () => {
  it('labels readable sources with no roles as having no open roles', () => {
    expect(sourceBadge(sources[2])).toEqual({ label: 'No open roles', className: 'no-roles' });
    expect(sourceBadge(sources[0]).label).toBe('Complete feed');
    expect(sourceBadge(sources[1]).label).toBe('Partial feed');
    expect(sourceBadge(sources[3])).toEqual({ label: 'Access restricted', className: 'blocked' });
  });

  it('counts empty sources in their own tile and not as complete feeds', () => {
    expect(directorySummary(sources)).toEqual({ total: 4, complete: 1, empty: 1, providers: 2, restricted: 1 });
  });

  it('agrees with the overview counts from the API', () => {
    const stats = overview(sources);
    expect(directorySummary(sources).complete).toBe(stats.completeSources);
    expect(directorySummary(sources).empty).toBe(stats.emptySources);
  });
});

describe('home page coverage wording', () => {
  it('mentions empty sources under the readable sources metric', () => {
    expect(readableSourcesNote(overview(sources))).toBe('1 of 4 fully retrieved, 1 with no open roles');
    expect(readableSourcesNote(overview([sources[0]]))).toBe('1 of 1 fully retrieved');
    expect(readableSourcesNote(undefined)).toBe('Checking sources');
  });

  it('explains partial, empty and unreadable sources separately', () => {
    expect(coverageNotice(overview(sources))).toBe('1 of 4 feeds fully retrieved, 1 more has partial results, 1 was read but has no open roles right now, 1 could not be read. A missing result may still be available on its original portal.');
  });

  it('does not report a gap when the only shortfall is sources with no open roles', () => {
    expect(coverageNotice(overview([sources[0], sources[2]]))).toBeNull();
    expect(coverageNotice(undefined)).toBeNull();
  });
});

describe('source directory filter', () => {
  const ids = (list: Source[]) => list.map(s => s.id);
  const all = { query: '', provider: ALL_PROVIDERS, showEmpty: true };

  it('shows every source by default, including those with no open roles', () => {
    expect(ids(filterSources(sources, all))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hides only sources with no open roles when asked', () => {
    expect(ids(filterSources(sources, { ...all, showEmpty: false }))).toEqual(['a', 'b', 'd']);
  });

  it('keeps unreadable sources visible because they are not empty feeds', () => {
    expect(filterSources(sources, { ...all, showEmpty: false }).some(s => s.status === 'blocked')).toBe(true);
  });

  it('combines the empty filter with the provider and search filters', () => {
    expect(ids(filterSources(sources, { ...all, provider: 'Workday', showEmpty: false }))).toEqual(['a', 'd']);
    expect(ids(filterSources(sources, { ...all, query: '  green ' }))).toEqual(['b']);
    expect(ids(filterSources(sources, { ...all, query: 'nobody' }))).toEqual([]);
  });
});
