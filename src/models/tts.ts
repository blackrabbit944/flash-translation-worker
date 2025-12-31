import { createDb } from '../db';
import { ttsLogs } from '../db/schema';
import { and, eq, isNotNull, desc } from 'drizzle-orm';

export async function logTts(
	d1: D1Database,
	data: {
		userId: string;
		inputTokens: number;
		outputTokens: number;
		text: string;
		costMicros: number;
		textHash: string;
		voiceName: string;
		modelName: string;
		languageCode?: string;
		url?: string;
	}
): Promise<void> {
	const db = createDb(d1);
	await db
		.insert(ttsLogs)
		.values({
			id: crypto.randomUUID().replace(/-/g, ''),
			userId: data.userId,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			text: data.text,
			costMicros: data.costMicros,
			textHash: data.textHash,
			voiceName: data.voiceName,
			modelName: data.modelName,
			languageCode: data.languageCode || null,
			url: data.url || null,
			createdAt: Date.now(),
		})
		.execute();
}

export async function findTtsLogByHash(
	d1: D1Database,
	textHash: string,
	voiceName: string,
	modelName: string,
	languageCode?: string
): Promise<{ url: string | null } | undefined> {
	const db = createDb(d1);

	// Basic conditions
	const conditions = [
		eq(ttsLogs.textHash, textHash),
		eq(ttsLogs.voiceName, voiceName),
		eq(ttsLogs.modelName, modelName),
		isNotNull(ttsLogs.url),
	];

	// Optional language code check
	if (languageCode) {
		conditions.push(eq(ttsLogs.languageCode, languageCode));
	}

	const result = await db
		.select({ url: ttsLogs.url })
		.from(ttsLogs)
		.where(and(...conditions))
		.limit(1)
		.execute();
	return result[0];
}

export async function findLatestTtsLogByTextHash(d1: D1Database, textHash: string): Promise<{ url: string | null } | undefined> {
	const db = createDb(d1);
	const result = await db
		.select({ url: ttsLogs.url })
		.from(ttsLogs)
		.where(and(eq(ttsLogs.textHash, textHash), isNotNull(ttsLogs.url)))
		.orderBy(desc(ttsLogs.createdAt))
		.limit(1)
		.execute();
	return result[0];
}

export async function findTtsRequest(
	d1: D1Database,
	textHash: string,
	voiceName: string,
	modelName: string,
	languageCode?: string
): Promise<{ url: string | null; status: string | null } | undefined> {
	const db = createDb(d1);

	const conditions = [eq(ttsLogs.textHash, textHash), eq(ttsLogs.voiceName, voiceName), eq(ttsLogs.modelName, modelName)];

	if (languageCode) {
		conditions.push(eq(ttsLogs.languageCode, languageCode));
	}

	const result = await db
		.select({ url: ttsLogs.url, status: ttsLogs.status })
		.from(ttsLogs)
		.where(and(...conditions))
		.orderBy(desc(ttsLogs.createdAt)) // Get latest
		.limit(1)
		.execute();
	return result[0];
}

export async function createPendingTtsLog(
	d1: D1Database,
	data: {
		userId: string;
		text: string;
		textHash: string;
		voiceName: string;
		modelName: string;
		languageCode?: string;
	}
): Promise<void> {
	const db = createDb(d1);
	await db
		.insert(ttsLogs)
		.values({
			id: crypto.randomUUID().replace(/-/g, ''),
			userId: data.userId,
			inputTokens: 0,
			outputTokens: 0,
			text: data.text,
			costMicros: 0,
			textHash: data.textHash,
			voiceName: data.voiceName,
			modelName: data.modelName,
			languageCode: data.languageCode || null,
			url: null,
			status: 'processing',
			createdAt: Date.now(),
		})
		.execute();
}

export async function updateTtsLogStatus(
	d1: D1Database,
	textHash: string,
	data: {
		url?: string;
		inputTokens: number;
		outputTokens: number;
		costMicros: number;
		status: 'completed' | 'failed';
	}
): Promise<void> {
	const db = createDb(d1);

	// Find the latest processing one
	const subquery = db
		.select({ id: ttsLogs.id })
		.from(ttsLogs)
		.where(and(eq(ttsLogs.textHash, textHash), eq(ttsLogs.status, 'processing')))
		.orderBy(desc(ttsLogs.createdAt))
		.limit(1);

	const targets = await subquery.execute();
	if (targets.length === 0) return;

	await db
		.update(ttsLogs)
		.set({
			url: data.url || null,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			costMicros: data.costMicros,
			status: data.status,
		})
		.where(eq(ttsLogs.id, targets[0].id))
		.execute();
}
