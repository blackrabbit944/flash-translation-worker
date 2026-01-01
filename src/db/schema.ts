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
		originalAppUserId: text('original_app_user_id'),
		expiresAt: integer('expires_at'),
		status: text('status').notNull(),
		updatedAt: integer('updated_at')
			.notNull()
			.default(sql`(strftime('%s', 'now') * 1000)`),
		isTrial: integer('is_trial').default(0),
		autoRenew: integer('auto_renew').default(1),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.entitlementId] }),
		idxOriginalAppUserId: index('idx_user_entitlements_original_app_user_id').on(table.originalAppUserId),
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

export const textClassifications = sqliteTable('text_classifications', {
	id: text('id').primaryKey(),
	textHash: text('text_hash').notNull().unique(),
	text: text('text').notNull(),
	classificationType: text('classification_type').notNull(), // 'word' | 'sentence' | 'multiple_sentences'
	createdAt: integer('created_at')
		.notNull()
		.default(sql`(strftime('%s', 'now') * 1000)`),
});

export const ttsLogs = sqliteTable('tts_logs', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	inputTokens: integer('input_tokens').notNull(),
	outputTokens: integer('output_tokens').notNull(),
	text: text('text').notNull(),
	costMicros: integer('cost_micros').notNull(),
	textHash: text('text_hash').notNull(),
	voiceName: text('voice_name').notNull(),
	modelName: text('model_name').notNull(),
	status: text('status').default('completed'),
	languageCode: text('language_code'),
	url: text('url'),
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
		durationSeconds: integer('duration_seconds'),
		requestHash: text('request_hash'),
		createdAt: integer('created_at')
			.notNull()
			.default(sql`(strftime('%s', 'now') * 1000)`),
	},
	(table) => ({
		idxUserEndpointCreated: index('idx_usage_logs_user_endpoint_created').on(table.userId, table.endpoint, table.createdAt),
	})
);

// Aggregated Stats DB
export const userUsageStats = sqliteTable(
	'user_usage_stats',
	{
		userId: text('user_id').notNull(),
		endpoint: text('endpoint').notNull(),
		// 'daily' | 'monthly' | 'total'
		periodType: text('period_type').notNull(),
		// 'YYYY-MM-DD' | 'YYYY-MM' | 'total'
		periodValue: text('period_value').notNull(),

		count: integer('count').notNull().default(0),
		// Only relevant for live translation (seconds)
		durationSeconds: integer('duration_seconds').notNull().default(0),
		// Optional: track total tokens if needed for cost analysis at a glance
		totalTokens: integer('total_tokens').notNull().default(0),
		updatedAt: integer('updated_at')
			.notNull()
			.default(sql`(strftime('%s', 'now') * 1000)`),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.endpoint, table.periodType, table.periodValue] }),
	})
);

export const userInitData = sqliteTable('user_init_data', {
	userId: text('user_id').primaryKey(),
	sourceLanguage: text('source_language'),
	targetLanguage: text('target_language'),
	whyUse: text('why_use'),
	howToKnown: text('how_to_known'),
	createdAt: integer('created_at')
		.notNull()
		.default(sql`(strftime('%s', 'now') * 1000)`),
});
