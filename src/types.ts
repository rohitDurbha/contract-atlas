export interface Job {
  id: string;
  sourceId: string;
  sourceJobId: string;
  company: string;
  title: string;
  location: string;
  country: string;
  workMode: 'Remote' | 'Hybrid' | 'On-site' | 'Unspecified';
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
}
