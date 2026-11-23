import { describe, it, expect } from 'vitest';
import { EMPTY_FILTERS, family, filterJobs, fuzzy, inSegment, payLabel, relative, type StartupCompany, type StartupJob } from '../src/startup/data';

const company = (id: string, extra: Partial<StartupCompany> = {}): StartupCompany => ({
  id, name: id[0].toUpperCase() + id.slice(1), focus: 'AI agents', location: 'SF', ats: 'ashby', board: id, boardUrl: null,
  status: 'ok', message: null, roleCount: 1, remoteCount: 0, checkedAt: null, ...extra,
});
const job = (id: string, companyId: string, extra: Partial<StartupJob> = {}): StartupJob => ({
  id, companyId, title: 'Software Engineer', team: null, location: 'San Francisco', remote: false, employmentType: 'Full Time',
  postedAt: '2026-11-20T00:00:00Z', firstSeenAt: '2026-11-20T00:00:00Z', url: 'https://example.com', payMin: null, payMax: null,
  currency: null, payInterval: null, ...extra,
});

describe('StartupAtlas view helpers', () => {
  const companies = new Map([
    ['omni', company('omni', { fastestRank: 27 })],
    ['ramp', company('ramp', { tier: '250+' })],
    ['hone', company('hone', { tier: '1-10' })],
  ]);
  const jobs = [
    job('1', 'omni', { title: 'Account Executive', remote: true }),
    job('2', 'ramp', { title: 'Senior Backend Engineer', payMin: 180000, payMax: 240000, currency: 'USD', payInterval: 'year' }),
    job('3', 'hone', { title: 'Research Scientist', team: 'Research' }),
  ];

  it('puts companies in the right size group', () => {
    expect(inSegment(companies.get('omni')!, 'fastest')).toBe(true);
    expect(inSegment(companies.get('ramp')!, 'large')).toBe(true);
    expect(inSegment(companies.get('hone')!, 'early')).toBe(true);
    expect(inSegment(companies.get('hone')!, 'growth')).toBe(false);
  });

  it('reads a role family from the title before the team', () => {
    expect(family({ title: 'Account Executive', team: 'Engineering' })).toBe('Sales');
    expect(family({ title: 'Member of Technical Staff', team: 'Research' })).toBe('Research');
    expect(family({ title: 'Chief Vibes Officer', team: null })).toBe('Other');
  });

  it('combines every filter', () => {
    expect(filterJobs(jobs, companies, EMPTY_FILTERS).map(j => j.id)).toEqual(['1', '2', '3']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, remote: true }).map(j => j.id)).toEqual(['1']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, withPay: true }).map(j => j.id)).toEqual(['2']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, family: 'Research' }).map(j => j.id)).toEqual(['3']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, query: 'ramp backend' }).map(j => j.id)).toEqual(['2']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, segment: 'fastest' }).map(j => j.id)).toEqual(['1']);
    expect(filterJobs(jobs, companies, { ...EMPTY_FILTERS, company: 'hone' }).map(j => j.id)).toEqual(['3']);
  });

  it('formats pay and age compactly', () => {
    expect(payLabel(jobs[1])).toBe('$180k–240k/yr');
    expect(payLabel({ payMin: 55, payMax: null, currency: 'EUR', payInterval: 'hour' })).toBe('€55/hr');
    expect(payLabel(jobs[0])).toBe('—');
    const now = Date.parse('2026-11-23T00:00:00Z');
    expect(relative('2026-11-20T00:00:00Z', now)).toBe('3d');
    expect(relative('2026-11-22T21:00:00Z', now)).toBe('3h');
    expect(relative(null, now)).toBe('—');
  });

  it('ranks fuzzy matches by word starts and runs', () => {
    expect(fuzzy('Factory', 'fact')).toBeGreaterThan(fuzzy('Fractile', 'fact'));
    expect(fuzzy('Baseten', 'xyz')).toBe(-1);
  });
});
