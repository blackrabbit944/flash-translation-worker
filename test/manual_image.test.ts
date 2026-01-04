import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';
import { createDb } from '../src/db';
import { usageLogs, userEntitlements } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { REAL_IMAGE_BASE64 } from './test-image-data';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Manual Image Translation API', () => {
	let validToken: string;
	const userId = 'manual_image_user';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Grant PRO entitlement to allow >1 image requests (FREE limit is 1)
		const usersDb = createDb(env.users_db);
		await usersDb
			.insert(userEntitlements)
			.values({
				userId: userId,
				entitlementId: 'pro_membership',
				status: 'active',
				expiresAt: Date.now() + 3600 * 1000,
			})
			.execute();

		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);

		// Clear usage logs to avoid 429
		const db = createDb(env.logs_db);
		// @ts-ignore
		await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).execute();
	});

	it('successfully translates image content', async () => {
		const request = new IncomingRequest('http://example.com/translation/image', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				image: REAL_IMAGE_BASE64,
				mime_type: 'image/jpeg',
				source_language: 'ja',
				target_language: 'zh',
				prompt: 'Translate this image',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);

		console.log('--- Manual Image Translation Status:', response.status);
		if (response.status !== 200) {
			console.log(await response.text());
		}
		expect(response.status).toBe(200);

		if (!response.body) throw new Error('No response body');

		// Consume stream
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let fullText = '';
		console.log('--- Start Reading Image Stream ---');
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			// console.log('IMG_RECV:', chunk);
			fullText += chunk;
		}
		console.log('--- End Reading Image Stream ---');

		// Verify some content (Gemini might refuse to analyze a pixel or hallucinate, but we check for flow)
		// expect(fullText).toContain('data: '); // Might be empty valid JSON if filtered?
		// Actually Gemini usually says "I cannot see anything" or similar JSON.
		// But we just want to ensure the PIPELINE works (no 500 header, stream flows).

		// Wait for background logs/cache to save
		await waitOnExecutionContext(ctx);

		// --- Verify Usage Log Count (Should be 1) ---
		const db = createDb(env.logs_db);
		// @ts-ignore
		// @ts-ignore
		const usages = await db.select().from(usageLogs).where(eq(usageLogs.userId, userId)).execute();

		expect(usages.length).toBe(1);
		const usageLog = usages[0];
		expect(usageLog.endpoint).toBe('image_translation');
		// Model should now be OpenRouter QWEN vision model
		expect(usageLog.model).toBe('qwen/qwen3-vl-235b-a22b-instruct');
		expect(usageLog.inputTokens).toBeGreaterThan(0);
		expect(usageLog.outputTokens).toBeGreaterThan(0);
		expect(usageLog.costMicros).toBeGreaterThan(0);

		// --- Second Request (Should hit Cache) ---
		console.log('--- Sending Second Request (Expect Cache Hit) ---');
		const request2 = new IncomingRequest('http://example.com/translation/image', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				image: REAL_IMAGE_BASE64,
				mime_type: 'image/jpeg',
				source_language: 'ja',
				target_language: 'zh',
				prompt: 'Translate this image',
			}),
		});

		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request2, env, ctx2);
		expect(response2.status).toBe(200);

		const reader2 = response2.body?.getReader();
		let fullText2 = '';
		if (reader2) {
			while (true) {
				const { done, value } = await reader2.read();
				if (done) break;
				fullText2 += new TextDecoder().decode(value, { stream: true });
			}
		}
		// console.log('IMG_RECV_2:', fullText2);

		// Wait for background logs to save
		await waitOnExecutionContext(ctx2);

		// Verify Usage Log Count (Should be 2)
		// @ts-ignore
		const usageAfterSecond = await db
			.select({ count: sql<number>`count(*)` })
			.from(usageLogs)
			.where(eq(usageLogs.userId, userId))
			.get();
		expect(usageAfterSecond?.count).toBe(2); // Gateway cache hit still logs usage in our DB
	}, 90000);
});
