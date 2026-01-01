import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi, beforeEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { usageLogs, userUsageStats } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Long Text Translation API', () => {
	let validToken: string;
	const userId = 'test_user_longtext';

	// Mock fetch to avoid hitting real Gemini API
	const fetchMock = vi.fn();
	globalThis.fetch = fetchMock;

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

	beforeEach(() => {
		fetchMock.mockReset();
		// Default mock response to prevent crashes if tests fall through
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
	});

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			body: JSON.stringify({
				text: 'This is a long text',
				source_language: 'en',
				target_language: 'es',
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
		let request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				source_language: 'en',
				target_language: 'es',
			}),
		});
		let response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required fields');

		// Missing target_language
		request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'Some text',
				source_language: 'en',
			}),
		});
		response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(400);
	});

	it('validates invalid language codes', async () => {
		const request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'Some text',
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

	it('successfully translates long text (mocked)', async () => {
		// Mock the Service method directly to avoid stream complexity in tests
		const { GeminiService } = await import('../src/services/gemini');
		const serviceSpy = vi.spyOn(GeminiService.prototype, 'translateLongTextAndStream');

		serviceSpy.mockResolvedValue(
			new Response('Esta es una traducción larga simulada', {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		);

		const request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'This is a simulated long text.',
				source_language: 'en',
				target_language: 'es',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		const text = await response.text();
		expect(text).toContain('Esta es una traducción larga simulada');
		// Verify service was called
		expect(serviceSpy).toHaveBeenCalled();
	});

	it('enforces shared rate limits (free tier default)', async () => {
		// Use a distinct user for rate limit test
		const limitUserId = 'limit_user_longtext';
		const payload = { uid: limitUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const limitToken = await sign(payload, env.JWT_SECRET);

		const { userUsageStats, usageLogs } = await import('../src/db/schema');
		const limit = 40; // Free tier daily limit is 40

		const db = createDb(env.logs_db);

		// Optimization: Batch insert valid logs (optional but good for consistency)
		const logsBatch = Array.from({ length: limit }).map((_, i) => ({
			id: `rate_limit_longtext_${i}`,
			userId: limitUserId,
			endpoint: 'text_translation',
			model: 'test',
			inputTokens: 10,
			outputTokens: 10,
			costMicros: 100,
			createdAt: Date.now(),
		}));

		const chunkSize = 10;
		for (let i = 0; i < logsBatch.length; i += chunkSize) {
			const chunk = logsBatch.slice(i, i + chunkSize);
			await db.insert(usageLogs).values(chunk).execute();
		}

		// Optimization: Insert SINGLE aggregated stats row with count = limit
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

		// Ensure fetch mock is ready just in case (though it shouldn't be reached)
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		// Now request should fail
		const request = new IncomingRequest('http://example.com/translation/longtext', {
			method: 'POST',
			headers: { Authorization: `Bearer ${limitToken}` },
			body: JSON.stringify({
				text: 'should_fail_limit',
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
		// Verify fetch was NOT called
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('enforces total usage limit for free tier', async () => {
		const totalUserId = 'total_user_longtext';
		const payload = { uid: totalUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		const limit = 101; // Free tier total limit is 100
		const twoMonthsAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

		// Optimization: Batch insert logs (chunked to avoid D1 variable limit)
		const logsBatch = Array.from({ length: limit }).map((_, i) => ({
			id: `total_longtext_${i}`,
			userId: totalUserId,
			endpoint: 'text_translation',
			model: 'test',
			inputTokens: 10,
			outputTokens: 10,
			costMicros: 100,
			createdAt: twoMonthsAgo,
		}));

		const chunkSize = 10;
		for (let i = 0; i < logsBatch.length; i += chunkSize) {
			const chunk = logsBatch.slice(i, i + chunkSize);
			await db.insert(usageLogs).values(chunk).execute();
		}

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

		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		const request = new IncomingRequest('http://example.com/translation/longtext', {
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
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
