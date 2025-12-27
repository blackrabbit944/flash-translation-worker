import { sql, and, eq, gte, lt } from 'drizzle-orm';
import { createDb } from '../db';
import { usageLogs } from '../db/schema';

export async function getUsageStats(
	d1: D1Database,
	userId: string,
	endpoint: string = 'text_translation',
	includeTotal: boolean = false
): Promise<{ daily: number; monthly: number; total: number }> {
	const db = createDb(d1);
	const now = new Date();

	const startOfDay = new Date(now);
	startOfDay.setHours(0, 0, 0, 0);
	const startOfDayTs = startOfDay.getTime();

	const startOfMonth = new Date(now);
	startOfMonth.setDate(1);
	startOfMonth.setHours(0, 0, 0, 0);
	const startOfMonthTs = startOfMonth.getTime();

	// If we need total, we must scan everything (no time filter).
	// If we ONLY need daily/monthly, we can optimize by filtering >= startOfMonth.
	const timeFilter = includeTotal ? undefined : gte(usageLogs.createdAt, startOfMonthTs);
	const filters = [eq(usageLogs.userId, userId), eq(usageLogs.endpoint, endpoint)];
	if (timeFilter) filters.push(timeFilter);

	const isLive = endpoint === 'live_translation';
	const valueExpression = isLive ? sql`COALESCE(${usageLogs.durationSeconds}, 0)` : sql`1`;

	const result = await db
		.select({
			daily: sql<number>`sum(case when ${usageLogs.createdAt} >= ${startOfDayTs} then ${valueExpression} else 0 end)`,
			monthly: sql<number>`sum(case when ${usageLogs.createdAt} >= ${startOfMonthTs} then ${valueExpression} else 0 end)`,
			total: includeTotal ? sql<number>`sum(${valueExpression})` : sql<number>`0`,
		})
		.from(usageLogs)
		.where(and(...filters))
		.get();

	return {
		daily: result?.daily || 0,
		monthly: result?.monthly || 0,
		total: result?.total || 0,
	};
}

export async function getDailyUsageCount(d1: D1Database, userId: string, endpoint: string = 'text_translation'): Promise<number> {
	const stats = await getUsageStats(d1, userId, endpoint);
	return stats.daily;
}

export async function logUsage(
	d1: D1Database,
	userId: string,
	model: string,
	inputTokens: number,
	outputTokens: number,
	costMicros: number,
	endpoint: string = 'text_translation',
	requestHash?: string,
	durationSeconds?: number
): Promise<void> {
	const db = createDb(d1);
	await db
		.insert(usageLogs)
		.values({
			id: crypto.randomUUID().replace(/-/g, ''),
			userId,
			endpoint,
			model,
			inputTokens,
			outputTokens,
			costMicros,
			durationSeconds: durationSeconds || null,
			requestHash: requestHash || null,
			createdAt: Date.now(),
		})
		.execute();
}
