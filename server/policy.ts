// Shared feed policy. Every listing, count, facet and adapter filter reads
// from here so the site never disagrees with itself about what is in scope.

// Roles posted within this many days are shown. Older roles stay out of the
// feed even when the source still lists them.
export const FEED_WINDOW_DAYS = 90;

// Rows older than this are deleted from the snapshot after each refresh.
// The extra month keeps first-seen dates stable for roles near the edge.
export const RETENTION_DAYS = FEED_WINDOW_DAYS + 30;

const DAY_MS = 86_400_000;

export function feedCutoff(now: Date | string = new Date()): Date {
  return new Date(new Date(now).getTime() - FEED_WINDOW_DAYS * DAY_MS);
}

export function retentionCutoff(now: Date | string = new Date()): Date {
  return new Date(new Date(now).getTime() - RETENTION_DAYS * DAY_MS);
}

// Mixed staffing boards also post permanent and direct-hire roles. This is a
// contract feed, so those are dropped. Contract-to-hire style roles stay.
export const PERMANENT_TYPES = ['perm', 'permanent', 'direct placement', 'direct hire', 'full time', 'full-time', 'permanent placement'];

export function isPermanentRole(employmentType: string | null | undefined): boolean {
  return PERMANENT_TYPES.includes(String(employmentType ?? '').trim().toLowerCase());
}
