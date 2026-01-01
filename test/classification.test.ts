import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';
import { createDb } from '../src/db';
import { userUsageStats } from '../src/db/schema';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Classification API', () => {
	let validToken: string;
	const userId = 'test_user_classify';

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

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			body: JSON.stringify({ text: 'hello' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('validates missing text parameter', async () => {
		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required field: text');
	});

	it('returns valid classification for single word (mocked)', async () => {
		// Mock GeminiService.classifyText
		const { GeminiService } = await import('../src/services/gemini');
		const spy = vi.spyOn(GeminiService.prototype, 'classifyText');
		spy.mockResolvedValue({ type: 'word' });

		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text: 'hello' }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.type).toBe('word');
		expect(spy).toHaveBeenCalled();
	});

	it('returns valid classification for sentence (mocked)', async () => {
		const { GeminiService } = await import('../src/services/gemini');
		const spy = vi.spyOn(GeminiService.prototype, 'classifyText');
		spy.mockResolvedValue({ type: 'sentence' });

		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text: 'Hello, how are you?' }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.type).toBe('sentence');
	});

	it('returns valid classification for paragraph (mocked)', async () => {
		const { GeminiService } = await import('../src/services/gemini');
		const spy = vi.spyOn(GeminiService.prototype, 'classifyText');
		spy.mockResolvedValue({ type: 'multiple_sentences' });

		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text: 'Hello. How are you? I am fine.' }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.type).toBe('multiple_sentences');
	});

	it('returns cached classification if exists', async () => {
		const text = 'cached_text';
		const classificationType = 'word';

		// Calculate hash
		const msgUint8 = new TextEncoder().encode(text);
		const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

		// Seed Cache
		const db = createDb(env.words_db);
		const { textClassifications } = await import('../src/db/schema');
		await db
			.insert(textClassifications)
			.values({
				id: 'test_cache_classify_1',
				textHash: hash,
				text: text,
				classificationType: classificationType,
				createdAt: Date.now(),
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text: text }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.type).toBe('word');
	});

	it('enforces rate limits (uses text_classify quota)', async () => {
		const limitUserId = 'limit_user_classify';
		const payload = { uid: limitUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const limitToken = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 40; // Free tier daily limit

		// Seed usage stats for text_classify endpoint
		const today = new Date().toISOString().slice(0, 10);
		await db
			.insert(userUsageStats)
			.values({
				userId: limitUserId,
				endpoint: 'text_classify',
				periodType: 'daily',
				periodValue: today,
				count: limit,
				durationSeconds: 0,
				totalTokens: limit * 20,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/classify', {
			method: 'POST',
			headers: { Authorization: `Bearer ${limitToken}` },
			body: JSON.stringify({ text: 'test' }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const bodyText = await response.text();
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(bodyText).toContain('Rate limit exceeded');
	});
});
