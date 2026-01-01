import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';
import { createDb } from '../src/db';
import { translations, usageLogs, userUsageStats } from '../src/db/schema';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function getMd5(text: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Word Translation API', () => {
	let validToken: string;
	const userId = 'test_user_word';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: 'zh',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('validates missing parameters', async () => {
		const ctx = createExecutionContext();

		// Missing text
		let request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				source_language: 'en',
				target_language: 'zh',
			}),
		});
		let response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required fields');

		// Missing target_language
		request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
			}),
		});
		response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(400);
	});

	it('validates invalid language codes', async () => {
		const request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: '123!',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid language code');
	});

	it('returns cached result if exists', async () => {
		const text = 'cache_word';
		const resultJson = JSON.stringify({
			type: 'word',
			original: 'cache_word',
			translation: '缓存词',
			phonetic: 'huǎn cún cí',
			examples: [],
		});
		const hash = await getMd5(text);

		// Seed Cache
		const db = createDb(env.words_db);
		await db
			.insert(translations)
			.values({
				id: 'test_cache_word_1',
				sourceTextHash: hash,
				sourceText: text,
				sourceLang: 'en-US',
				targetLang: 'zh-CN',
				resultJson: resultJson,
				createdAt: Date.now(),
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/word', {
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
		expect(bodyText).toContain('cache_word');
		expect(bodyText).toContain('data: ');
	});

	it('successfully translates word (mocked)', async () => {
		// Mock GeminiService.translateWordAndStream
		const { GeminiService } = await import('../src/services/gemini');
		const spy = vi.spyOn(GeminiService.prototype, 'translateWordAndStream');

		const mockResponse = JSON.stringify({
			type: 'word',
			original: 'hello',
			translation: '你好',
			phonetic: 'nǐ hǎo',
			examples: [
				{
					source: 'Hello, how are you?',
					target: '你好，你好吗？',
				},
			],
		});

		spy.mockResolvedValue(
			new Response(mockResponse, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		);

		const request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		const text = await response.text();
		expect(text).toContain('hello');
		expect(spy).toHaveBeenCalled();
	});

	it('enforces rate limits (shares text_translation quota)', async () => {
		const limitUserId = 'limit_user_word';
		const payload = { uid: limitUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const limitToken = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 40; // Free tier daily limit

		// Seed usage stats
		const today = new Date().toISOString().slice(0, 10);
		await db
			.insert(userUsageStats)
			.values({
				userId: limitUserId,
				endpoint: 'text_translation',
				periodType: 'daily',
				periodValue: today,
				count: limit,
				durationSeconds: 0,
				totalTokens: limit * 20,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${limitToken}` },
			body: JSON.stringify({
				text: 'test',
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const bodyText = await response.text();
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(bodyText).toContain('Rate limit exceeded');
	});

	it('enforces total usage limit for free tier', async () => {
		const totalUserId = 'total_user_word';
		const payload = { uid: totalUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 101; // Free tier total limit is 100

		// Seed usage stats
		await db
			.insert(userUsageStats)
			.values({
				userId: totalUserId,
				endpoint: 'text_translation',
				periodType: 'total',
				periodValue: 'total',
				count: limit,
				durationSeconds: 0,
				totalTokens: limit * 20,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/word', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				text: 'test',
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
