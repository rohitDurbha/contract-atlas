export interface Job {
  id: string;
  sourceId: string;
  sourceJobId: string;
  company: string;
  title: string;
  location: string;
  country: string;
  workMode: 'Remote' | 'Hybrid' | 'On-site' | 'Unspecified';
  employmentType?: string;
  category: string;
  description: string;
  skills: string[];
  duration: string | null;
  payMin: number | null;
  payMax: number | null;
  payPeriod: string | null;
  currency: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  applyUrl: string;
  provider: string;
  active: boolean;
  /** Seniority an LLM read from the posting at collection time, when known. */
  seniority?: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'principal';
  /** Plain job title without company names, locations or contract terms, when enriched. */
  normalizedTitle?: string;
  /** True when skills or work mode come from the stored enrichment instead of the listing. */
  enriched?: boolean;
  /** Cosine similarity to a described role, only on semantic search results. */
  similarity?: number;
}
export interface Source {
  id: string;
  company: string;
  provider: string;
  url: string;
  country: string;
  status: 'healthy' | 'blocked' | 'needs_adapter' | 'error' | 'pending';
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  jobCount: number;
  message: string | null;
  coverage: 'complete' | 'partial' | 'unavailable';
  /** Readable source with no roles in the current feed. */
  empty: boolean;
  advertisedCount: number | null;
  fetchedCount: number | null;
}
export interface Run {
  id: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string | null;
  sourceCount: number;
  successCount: number;
  newCount: number;
  jobCount: number;
}
export interface Overview {
  totalJobs: number;
  newToday: number;
  remoteJobs: number;
  companyCount: number;
  sourceCount: number;
  healthySources: number;
  completeSources: number;
  partialSources: number;
  /** Readable sources that currently have no roles in the feed. Not counted as healthy, complete or partial. */
  emptySources: number;
  lastRun: Run | null;
  nextRefreshAt: string | null;
  scheduleEnabled: boolean;
}
export interface Feed {
  jobs: Job[];
  total: number;
  page: number;
  pages: number;
  facets: { companies: { name: string; count: number }[]; categories: { name: string; count: number }[]; countries: string[] };
  /** How a semantic request was answered. Absent on ordinary keyword requests. */
  search?: FeedSearch;
}
export interface FeedSearch {
  /** "semantic" when roles were ranked by meaning, "keyword" when the request fell back to text matching. */
  mode: 'semantic' | 'keyword';
  /** Why a semantic request fell back to keyword search. */
  fallback?: string;
  /** Roles that matched the filters but had no stored vector, so they could not be ranked. */
  rolesWithoutVectors?: number;
}
