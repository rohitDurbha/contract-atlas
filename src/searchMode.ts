import type { FeedSearch } from './types';

// The jobs search box works in two ways. "keyword" matches the words typed
// against titles, skills and companies. "describe" sends a plain description
// of the role to the semantic search, which ranks every role that passes the
// other filters by how close its meaning is.
export type SearchMode = 'keyword' | 'describe';

// The server embeds at most this many characters of a description, so the
// box stops there and the visitor sees what will be used.
export const DESCRIBE_MAX_CHARS = 300;

export const SEARCH_PLACEHOLDER: Record<SearchMode, string> = {
  keyword: 'Job title, skill, or company',
  describe: 'Describe the role, like remote data engineer building Airflow pipelines',
};

// Adds the search text to the jobs request. A description asks the API for
// semantic ranking, which orders roles by similarity, so the sort option is
// left out of the request.
export function applySearch(params: URLSearchParams, mode: SearchMode, text: string): URLSearchParams {
  const query = mode === 'describe' ? text.trim().slice(0, DESCRIBE_MAX_CHARS) : text.trim();
  if (!query) return params;
  params.set('q', query);
  if (mode === 'describe') {
    params.set('semantic', '1');
    params.delete('sort');
  }
  return params;
}

export interface SearchStatus { tone: 'semantic' | 'fallback'; text: string }

// The line shown above the results after a described search, so a visitor
// knows whether the order reflects meaning or fell back to keywords.
export function searchStatus(mode: SearchMode, text: string, search?: FeedSearch): SearchStatus | null {
  if (mode !== 'describe' || !text.trim() || !search) return null;
  if (search.mode === 'semantic') {
    const waiting = search.rolesWithoutVectors ?? 0;
    const note = waiting > 0 ? ` ${waiting} newer ${waiting === 1 ? 'role is' : 'roles are'} not ranked yet and will join after the next refresh.` : '';
    return { tone: 'semantic', text: `Roles are ordered by how closely they match your description.${note}` };
  }
  return { tone: 'fallback', text: `Showing keyword matches instead. ${search.fallback ?? 'Semantic search is not available right now.'}` };
}

// A short label for how close a role is to the description. Cosine scores
// from bge-small sit between about 0.5 for unrelated roles and 0.9 for near
// copies, so plain bands read better than a raw percentage.
export function matchLabel(similarity: number | undefined): string | null {
  if (typeof similarity !== 'number' || !Number.isFinite(similarity)) return null;
  if (similarity >= 0.8) return 'Close match';
  if (similarity >= 0.72) return 'Good match';
  return 'Loose match';
}
