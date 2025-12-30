import { createDb } from '../db';
import { userInitData } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface UserInitData {
	sourceLanguage?: string;
	targetLanguage?: string;
	whyUse?: string;
	howToKnown?: string;
}

export async function saveUserInitData(d1: D1Database, userId: string, data: UserInitData) {
	const db = createDb(d1);
	await db
		.insert(userInitData)
		.values({
			userId,
			sourceLanguage: data.sourceLanguage,
			targetLanguage: data.targetLanguage,
			whyUse: data.whyUse,
			howToKnown: data.howToKnown,
		})
		.onConflictDoUpdate({
			target: userInitData.userId,
			set: {
				sourceLanguage: data.sourceLanguage,
				targetLanguage: data.targetLanguage,
				whyUse: data.whyUse,
				howToKnown: data.howToKnown,
			},
		})
		.execute();
}
