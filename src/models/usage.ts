import { sql, and, eq, gte, lt } from 'drizzle-orm';
import { createDb } from '../db';
import { usageLogs } from '../db/schema';

export async function getUsageStats(
	d1: D1Database,
	userId: string,
	endpoint: string = 'text_translation'
): Promise<{ daily: number; monthly: number }> {
	const db = createDb(d1);
	const now = new Date();

	const startOfDay = new Date(now);
	startOfDay.setHours(0, 0, 0, 0);
	const startOfDayTs = startOfDay.getTime();

	const startOfMonth = new Date(now);
	startOfMonth.setDate(1);
	startOfMonth.setHours(0, 0, 0, 0);
	const startOfMonthTs = startOfMonth.getTime();

	// Use conditional aggregation for single query efficiency
	const result = await db
		.select({
			daily: sql<number>`sum(case when ${usageLogs.createdAt} >= ${startOfDayTs} then 1 else 0 end)`,
			monthly: sql<number>`sum(case when ${usageLogs.createdAt} >= ${startOfMonthTs} then 1 else 0 end)`,
		})
		.from(usageLogs)
		.where(and(eq(usageLogs.userId, userId), eq(usageLogs.endpoint, endpoint), gte(usageLogs.createdAt, startOfMonthTs)))
		.get();

	return {
		daily: result?.daily || 0,
		monthly: result?.monthly || 0,
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
	requestHash?: string
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
			requestHash: requestHash || null,
			createdAt: Date.now(),
		})
		.execute();
}
