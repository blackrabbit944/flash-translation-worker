import { sql, and, eq } from 'drizzle-orm';
import { createDb } from '../db';
import { usageLogs, userUsageStats } from '../db/schema';

function getUtcDateStrings(date: Date) {
	// Format: YYYY-MM-DD
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(date.getUTCDate()).padStart(2, '0');
	const daily = `${yyyy}-${mm}-${dd}`;
	const monthly = `${yyyy}-${mm}`;
	return { daily, monthly };
}

export async function getUsageStats(
	d1: D1Database,
	userId: string,
	endpoint: string = 'text_translation',
	includeTotal: boolean = false
): Promise<{ daily: number; monthly: number; total: number }> {
	const db = createDb(d1);
	const now = new Date();
	const { daily: dailyKey, monthly: monthlyKey } = getUtcDateStrings(now);

	// We want to fetch 3 rows: Daily, Monthly, and Total (if requested)
	// We can do this in one query using OR or IN, then map them.
	// But since PK is composite, simpler to just select * where userId and endpoint match, and periodType is specific.

	const conditions = [eq(userUsageStats.userId, userId), eq(userUsageStats.endpoint, endpoint)];

	const stats = await db
		.select()
		.from(userUsageStats)
		.where(and(...conditions))
		.all();

	let dailyVal = 0;
	let monthlyVal = 0;
	let totalVal = 0;

	// 'count' is request count. 'durationSeconds' is for live.
	const isLive = endpoint === 'live_translation';
	const getValue = (row: typeof userUsageStats.$inferSelect) => (isLive ? row.durationSeconds : row.count);

	for (const row of stats) {
		if (row.periodType === 'daily' && row.periodValue === dailyKey) {
			dailyVal = getValue(row);
		} else if (row.periodType === 'monthly' && row.periodValue === monthlyKey) {
			monthlyVal = getValue(row);
		} else if (row.periodType === 'total' && row.periodValue === 'total') {
			totalVal = getValue(row);
		}
	}

	return {
		daily: dailyVal,
		monthly: monthlyVal,
		total: totalVal,
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
	const now = new Date();
	const { daily, monthly } = getUtcDateStrings(now);
	const totalTokens = inputTokens + outputTokens;
	const duration = durationSeconds || 0;

	// 1. Log detailed entry (Audit/Debug)
	const logPromise = db
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

	// 2. Update Aggregates (Daily, Monthly, Total)
	// We prepare the updates. Drizzle's `onConflictDoUpdate` is perfect here.

	const periodUpdates: { type: string; value: string }[] = [
		{ type: 'daily', value: daily },
		{ type: 'monthly', value: monthly },
		{ type: 'total', value: 'total' },
	];

	// Prepare promises for upserts
	const upsertPromises = periodUpdates.map((period) =>
		db
			.insert(userUsageStats)
			.values({
				userId,
				endpoint,
				periodType: period.type,
				periodValue: period.value,
				count: 1,
				durationSeconds: duration,
				totalTokens: totalTokens,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: [userUsageStats.userId, userUsageStats.endpoint, userUsageStats.periodType, userUsageStats.periodValue],
				set: {
					count: sql`${userUsageStats.count} + 1`,
					durationSeconds: sql`${userUsageStats.durationSeconds} + ${duration}`,
					totalTokens: sql`${userUsageStats.totalTokens} + ${totalTokens}`,
					updatedAt: Date.now(),
				},
			})
			.execute()
	);

	await Promise.all([logPromise, ...upsertPromises]);
}
