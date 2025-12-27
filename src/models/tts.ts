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
