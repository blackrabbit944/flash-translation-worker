import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userInitData } from '../src/db/schema';
import { sign } from '../src/utils/jwt';
import { eq } from 'drizzle-orm';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('User Init Data API', () => {
	let validToken: string;
	const userId = 'test_user_init_data';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('saves user init data', async () => {
		const payload = {
			source_language: 'en',
			target_language: 'zh',
			why_use: 'travel_abroad',
			how_to_known: 'twitter',
		};

		const request = new IncomingRequest('http://example.com/user/init-data', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.success).toBe(true);

		// Verify DB
		const db = createDb(env.users_db);
		const saved = await db.select().from(userInitData).where(eq(userInitData.userId, userId)).get();
		expect(saved).toBeDefined();
		if (saved) {
			expect(saved.sourceLanguage).toBe('en');
			expect(saved.targetLanguage).toBe('zh');
			expect(saved.whyUse).toBe('travel_abroad');
			expect(saved.howToKnown).toBe('twitter');
		}
	});

	it('updates existing init data', async () => {
		const payload = {
			source_language: 'ja',
			target_language: 'ko',
			why_use: 'living_abroad',
			how_to_known: 'youtube',
		};

		const request = new IncomingRequest('http://example.com/user/init-data', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Verify DB Update
		const db = createDb(env.users_db);
		const saved = await db.select().from(userInitData).where(eq(userInitData.userId, userId)).get();
		if (saved) {
			expect(saved.sourceLanguage).toBe('ja');
			expect(saved.targetLanguage).toBe('ko');
			expect(saved.whyUse).toBe('living_abroad');
			expect(saved.howToKnown).toBe('youtube');
		}
	});
});
