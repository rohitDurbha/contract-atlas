import type { Job } from './types';

const SENIORITY: Record<NonNullable<Job['seniority']>, string> = {
  intern: 'Intern', junior: 'Junior', mid: 'Mid level', senior: 'Senior', lead: 'Lead', principal: 'Principal',
};

// The label shown on a role's tags, or null when the level is not known.
export function seniorityLabel(job: Pick<Job, 'seniority'>): string | null {
  return job.seniority ? SENIORITY[job.seniority] ?? null : null;
}

const simplify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The plain title worth showing under the listed one. It is hidden when it
// only repeats the listed title with different case or punctuation.
export function plainTitle(job: Pick<Job, 'title' | 'normalizedTitle'>): string | null {
  const plain = job.normalizedTitle?.trim();
  if (!plain || simplify(plain) === simplify(job.title)) return null;
  return plain;
}
