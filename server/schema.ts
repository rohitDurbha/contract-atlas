import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), sourceId: text('source_id').notNull(), company: text('company').notNull(),
  title: text('title').notNull(), location: text('location').notNull(), country: text('country').notNull(),
  workMode: text('work_mode').notNull(), category: text('category').notNull(), payMin: real('pay_min'),
  payMax: real('pay_max'), postedAt: text('posted_at'), firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(), applyUrl: text('apply_url').notNull(), active: integer('active').notNull().default(1), data: text('data').notNull(),
}, t => [index('jobs_freshness').on(t.active,t.postedAt),index('jobs_filter').on(t.company,t.category,t.workMode)]);
export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(), company: text('company').notNull(), provider: text('provider').notNull(),
  url: text('url').notNull(), country: text('country').notNull(), status: text('status').notNull().default('pending'),
  lastCheckedAt: text('last_checked_at'), lastSuccessAt: text('last_success_at'), message: text('message'),
});
