import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { translations, usageLogs } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function getMd5(text: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Text Translation API', () => {
	let validToken: string;
	const userId = 'test_user_trans';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Generate token
		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: 'es',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns cached result if exists', async () => {
		const text = 'cache_me';
		const resultJson = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'cached_translation' }] } }] });
		const hash = await getMd5(text);

		// Seed Cache
		const db = createDb(env.words_db);
		await db
			.insert(translations)
			.values({
				id: 'test_cache_1',
				sourceTextHash: hash,
				sourceText: text,
				sourceLang: 'en-US',
				targetLang: 'zh-CN',
				resultJson: resultJson,
				createdAt: Date.now(),
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: text,
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const bodyText = await response.text();
		expect(bodyText).toContain('cached_translation');
		expect(bodyText).toContain('data: ');
	});

	it('enforces rate limits (free tier default)', async () => {
		// Seed logs to exceed limit (5)
		const db = createDb(env.logs_db);
		const limit = 5;

		for (let i = 0; i < limit; i++) {
			await db
				.insert(usageLogs)
				.values({
					id: `log_${i}`,
					userId: userId,
					endpoint: 'text_translation',
					model: 'test',
					inputTokens: 10,
					outputTokens: 10,
					costMicros: 100,
					createdAt: Date.now(),
				})
				.execute();
		}

		// Now request should fail
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'should_fail',
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Clean up response body to avoid leak warning
		const bodyText = await response.text();
		console.log('Rate limit check:', response.status, bodyText);

		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(bodyText).toContain('Rate limit exceeded');
	});
	it('enforces total usage limit for free tier (text)', async () => {
		const totalUserId = 'total_user_text';
		const payload = { uid: totalUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 10;
		const twoMonthsAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

		for (let i = 0; i < limit; i++) {
			await db
				.insert(usageLogs)
				.values({
					id: `total_text_${i}`,
					userId: totalUserId,
					endpoint: 'text_translation',
					model: 'test',
					inputTokens: 10,
					outputTokens: 10,
					costMicros: 100,
					createdAt: twoMonthsAgo,
				})
				.execute();
		}

		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({ text: 'fail', source_language: 'en', target_language: 'zh' }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const bodyText = await response.text();
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(bodyText).toContain('Total Usage limit exceeded');
	});

	it('enforces total usage limit for free tier (image)', async () => {
		const totalUserId = 'total_user_image';
		const payload = { uid: totalUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 3; // FREE tier image limit is 3
		const twoMonthsAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

		for (let i = 0; i < limit; i++) {
			await db
				.insert(usageLogs)
				.values({
					id: `total_image_${i}`,
					userId: totalUserId,
					endpoint: 'image_translation',
					model: 'test',
					inputTokens: 10,
					outputTokens: 10,
					costMicros: 100,
					createdAt: twoMonthsAgo,
				})
				.execute();
		}

		const request = new IncomingRequest('http://example.com/translation/image', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				image: 'base64data',
				mime_type: 'image/jpeg',
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const bodyText = await response.text();
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(bodyText).toContain('Total Usage limit exceeded');
	});
});
