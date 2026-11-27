import { describe, it, expect } from 'vitest';
import { DESCRIBE_MAX_CHARS, applySearch, matchLabel, searchStatus } from '../src/searchMode';
import { MAX_DESCRIPTION_CHARS } from '../server/semantic-feed';

const base = () => new URLSearchParams({ page: '1', sort: 'newest' });

describe('building the jobs request from the search box', () => {
  it('sends keywords as an ordinary text query and keeps the sort', () => {
    expect(applySearch(base(), 'keyword', '  Data Engineer ').toString()).toBe('page=1&sort=newest&q=Data+Engineer');
  });

  it('asks for semantic ranking and drops the sort for a description', () => {
    const params = applySearch(base(), 'describe', 'remote data engineer building pipelines');
    expect(params.get('semantic')).toBe('1');
    expect(params.get('q')).toBe('remote data engineer building pipelines');
    expect(params.has('sort')).toBe(false);
    expect(params.get('page')).toBe('1');
  });

  it('leaves the request alone when nothing was typed', () => {
    expect(applySearch(base(), 'describe', '   ').toString()).toBe('page=1&sort=newest');
    expect(applySearch(base(), 'keyword', '').toString()).toBe('page=1&sort=newest');
  });

  it('cuts a description at the length the server embeds', () => {
    expect(DESCRIBE_MAX_CHARS).toBe(MAX_DESCRIPTION_CHARS);
    expect(applySearch(base(), 'describe', 'x'.repeat(500)).get('q')).toHaveLength(DESCRIBE_MAX_CHARS);
  });
});

describe('telling the visitor how results were ordered', () => {
  it('says nothing for keyword searches or before a description is sent', () => {
    expect(searchStatus('keyword', 'data', { mode: 'keyword' })).toBeNull();
    expect(searchStatus('describe', '', { mode: 'keyword', fallback: 'Describe the role to rank roles by meaning.' })).toBeNull();
    expect(searchStatus('describe', 'data', undefined)).toBeNull();
  });

  it('confirms ranking by meaning and counts roles still waiting for a vector', () => {
    expect(searchStatus('describe', 'data', { mode: 'semantic', rolesWithoutVectors: 0 })).toEqual({ tone: 'semantic', text: 'Roles are ordered by how closely they match your description.' });
    expect(searchStatus('describe', 'data', { mode: 'semantic', rolesWithoutVectors: 1 })!.text).toContain('1 newer role is not ranked yet');
    expect(searchStatus('describe', 'data', { mode: 'semantic', rolesWithoutVectors: 4 })!.text).toContain('4 newer roles are not ranked yet');
  });

  it('passes on the reason when the server fell back to keywords', () => {
    expect(searchStatus('describe', 'data', { mode: 'keyword', fallback: 'No roles have been embedded yet.' }))
      .toEqual({ tone: 'fallback', text: 'Showing keyword matches instead. No roles have been embedded yet.' });
    expect(searchStatus('describe', 'data', { mode: 'keyword' })!.text).toContain('not available right now');
  });
});

describe('labelling how close a role is', () => {
  it('uses plain bands and hides the label without a score', () => {
    expect(matchLabel(0.835)).toBe('Close match');
    expect(matchLabel(0.75)).toBe('Good match');
    expect(matchLabel(0.6)).toBe('Loose match');
    expect(matchLabel(undefined)).toBeNull();
    expect(matchLabel(Number.NaN)).toBeNull();
  });
});
