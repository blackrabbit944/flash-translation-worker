import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	credential: text('credential').notNull().unique(),
	refreshToken: text('refresh_token'),
	refreshTokenExpiresAt: integer('refresh_token_expires_at'),
	createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`),
});

export const userEntitlements = sqliteTable(
	'user_entitlements',
	{
		userId: text('user_id').notNull(),
		entitlementId: text('entitlement_id').notNull(),
		expiresAt: integer('expires_at'),
		status: text('status').notNull(),
		updatedAt: integer('updated_at')
			.notNull()
			.default(sql`(strftime('%s', 'now') * 1000)`),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.entitlementId] }),
	})
);
// Words DB
export const translations = sqliteTable('translations', {
	id: text('id').primaryKey(),
	sourceTextHash: text('source_text_hash').notNull(),
	sourceText: text('source_text').notNull(),
	sourceLang: text('source_lang').notNull(),
	targetLang: text('target_lang').notNull(),
	resultJson: text('result_json').notNull(),
	createdAt: integer('created_at')
		.notNull()
		.default(sql`(strftime('%s', 'now') * 1000)`),
});

// Logs DB
export const usageLogs = sqliteTable(
	'usage_logs',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		endpoint: text('endpoint').notNull(),
		model: text('model').notNull(),
		inputTokens: integer('input_tokens').notNull(),
		outputTokens: integer('output_tokens').notNull(),
		costMicros: integer('cost_micros').notNull(),
		requestHash: text('request_hash'),
		createdAt: integer('created_at')
			.notNull()
			.default(sql`(strftime('%s', 'now') * 1000)`),
	},
	(table) => ({
		idxUserEndpointCreated: index('idx_usage_logs_user_endpoint_created').on(table.userId, table.endpoint, table.createdAt),
	})
);
