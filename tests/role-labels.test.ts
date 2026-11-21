import { describe, it, expect } from 'vitest';
import { plainTitle, seniorityLabel } from '../src/roleLabels';

describe('role labels from enrichment', () => {
  it('names known seniority levels and hides unknown ones', () => {
    expect(seniorityLabel({ seniority: 'senior' })).toBe('Senior');
    expect(seniorityLabel({ seniority: 'mid' })).toBe('Mid level');
    expect(seniorityLabel({})).toBeNull();
  });

  it('shows the plain title only when it says something the listed title does not', () => {
    expect(plainTitle({ title: 'Sr. Data Engineer (W2) - Req 4471', normalizedTitle: 'Senior Data Engineer' })).toBe('Senior Data Engineer');
    expect(plainTitle({ title: 'Data Engineer', normalizedTitle: 'data engineer' })).toBeNull();
    expect(plainTitle({ title: 'AI/ML Engineer', normalizedTitle: 'AI ML Engineer' })).toBeNull();
    expect(plainTitle({ title: 'Data Engineer', normalizedTitle: '  ' })).toBeNull();
    expect(plainTitle({ title: 'Data Engineer' })).toBeNull();
  });
});
