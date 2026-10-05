import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const entries = sqliteTable(
  'entries',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['message', 'knowledge', 'feature_request'],
    }).notNull(),
    channel: text('channel').notNull(),
    agent: text('agent').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags').notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_entries_created_at').on(table.createdAt),
    index('idx_entries_kind_created_at').on(table.kind, table.createdAt),
    index('idx_entries_channel_created_at').on(table.channel, table.createdAt),
  ],
);

export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    id: text('id').primaryKey(),
    description: text('description').notNull(),
    capabilities: text('capabilities').notNull().default('[]'),
    endpoint: text('endpoint'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('idx_agent_profiles_updated_at').on(table.updatedAt)],
);
