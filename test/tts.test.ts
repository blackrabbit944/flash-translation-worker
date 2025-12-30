import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { ttsLogs, usageLogs } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('TTS API', () => {
	let validToken: string;
	const userId = 'test_user_tts';

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

	afterEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			body: JSON.stringify({
				text: 'hello',
				voiceName: 'Kore',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('rejects missing text', async () => {
		const request = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				voiceName: 'Kore',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required field');
	});

	it('rejects invalid voice', async () => {
		const request = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello',
				voiceName: 'Invalid',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Only "Kore" voice is supported');
	});

	it('successfully generates audio and logs usage', async () => {
		// Mock Gemini API
		const mockAudioData = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; // Minimal WAV base64
		// The controller expects the API to return base64 in inlineData.data
		// Let's emulate the Gemini response structure

		fetchMock
			.get('https://generativelanguage.googleapis.com')
			.intercept({
				path: /\/v1beta\/models\/.*:generateContent/,
				method: 'POST',
			})
			.reply(200, {
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										mimeType: 'audio/wav',
										data: mockAudioData,
									},
								},
							],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 100,
				},
			});

		const request = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello world',
				voiceName: 'Kore',
				languageCode: 'en',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');

		const body = (await response.json()) as any;
		// Expect local preview URL in test env
		expect(body.audio_url).toContain('https://kiwi-api-local.jianda.com/tts/preview?hash=');
		// expect(body.audio_url).toContain(userId); // Hash based URL doesn't contain userId

		// Verify R2 mock?
		// cloudflare:test env usually mocks R2 in memory.
		const list = await env.TTS_BUCKET.list();
		expect(list.objects.length).toBeGreaterThan(0);
		const key = list.objects[0].key;
		expect(key).toContain(userId);

		// Verify DB Log
		const db = createDb(env.words_db);
		const logs = await db.select().from(ttsLogs).execute();
		expect(logs.length).toBe(1);
		expect(logs[0].userId).toBe(userId);
		expect(logs[0].text).toBe('hello world');
		expect(logs[0].inputTokens).toBe(10);
		expect(logs[0].outputTokens).toBe(100);
		expect(logs[0].url).toContain('r2://');
		// Verify Usage DB Log
		const logsDb = createDb(env.logs_db);
		const uLogs = await logsDb.select().from(usageLogs).execute();
		const relatedUsage = uLogs.find((l) => l.userId === userId && l.endpoint === 'tts');
		expect(relatedUsage).toBeDefined();
		if (relatedUsage) {
			expect(relatedUsage.inputTokens).toBe(10);
			expect(relatedUsage.outputTokens).toBe(100);
			expect(relatedUsage.model).toBe('gemini-2.5-flash-preview-tts');

			// Pricing:
			// Input (Text): 10 * 0.5 = 5
			// Output (Audio): 100 * 10 = 1000
			// Total: 1005
			expect(relatedUsage.costMicros).toBe(1005);
		}
	});

	it.skip('REAL INTEGRATION: calls Google Gemini API and returns audio', async () => {
		if (!env.GEMINI_API_KEY) {
			console.warn('Skipping real integration test because GEMINI_API_KEY is missing');
			return;
		}

		// Enable real network requests
		fetchMock.activate();
		fetchMock.enableNetConnect();

		const text = 'Hello from integration test';
		const request = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text,
				voiceName: 'Kore',
				languageCode: 'en',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');

		const body = (await response.json()) as any;
		expect(body.audio_url).toBeDefined();
		expect(body.audio_url).toContain('r2://');

		// Verify DB Log
		const db = createDb(env.words_db);
		// Wait a bit? D1 is usually immediate in tests
		const logs = await db.select().from(ttsLogs).execute();
		const lastLog = logs.find((l) => l.text === text);
		expect(lastLog).toBeDefined();
		expect(lastLog!.userId).toBe(userId);
		expect(lastLog!.url).toBe(body.audio_url);
	});

	it('returns cached result for duplicate requests', async () => {
		const text = 'cache test';

		// Setup Mock
		const mockAudioData = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
		const interceptor = fetchMock
			.get('https://generativelanguage.googleapis.com')
			.intercept({
				path: /\/v1beta\/models\/.*:generateContent/,
				method: 'POST',
			})
			.reply(200, {
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										mimeType: 'audio/wav',
										data: mockAudioData,
									},
								},
							],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 100,
				},
			});

		// 1. First Request
		const request1 = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore' }),
		});
		const ctx1 = createExecutionContext();
		const response1 = await worker.fetch(request1, env, ctx1);
		await waitOnExecutionContext(ctx1);
		const body1 = (await response1.json()) as any;
		expect(response1.status).toBe(200);

		// 2. Second Request (Same text)
		// Clear mock logic if needed, but fetchMock accumulates calls.
		// We want to ensure Gemini is NOT called again.
		// fetchMock in cloudflare:test is tricky to count calls directly without spy.
		// But we can check the returned URL is identical.

		const request2 = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore' }),
		});
		const ctx2 = createExecutionContext();
		const response2 = await worker.fetch(request2, env, ctx2);
		await waitOnExecutionContext(ctx2);
		const body2 = (await response2.json()) as any;
		expect(response2.status).toBe(200);

		expect(body1.audio_url).toBe(body2.audio_url);
		expect(body1.audio_url).toContain('https://kiwi-api-local.jianda.com/tts/preview?hash=');
	});

	it('differentiates language codes in cache', async () => {
		const text = 'Same Text';
		const mockAudioData = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

		// Setup Mock (reply same audio for simplicity, we check if they are separate entries)
		fetchMock
			.get('https://generativelanguage.googleapis.com')
			.intercept({
				path: /\/v1beta\/models\/.*:generateContent/,
				method: 'POST',
			})
			.reply(200, {
				candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: mockAudioData } }] } }],
				usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 },
			})
			.persist();

		// 1. Request with 'en' (normalized to en-US)
		const req1 = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore', languageCode: 'en' }),
		});
		const ctx1 = createExecutionContext();
		await worker.fetch(req1, env, ctx1);
		await waitOnExecutionContext(ctx1);

		// 2. Request with 'zh' (normalized to zh-CN)
		const req2 = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore', languageCode: 'zh' }),
		});
		const ctx2 = createExecutionContext();
		await worker.fetch(req2, env, ctx2);
		await waitOnExecutionContext(ctx2);

		// 3. Request with 'ja' (should normalize to ja-JP)
		const req3 = new IncomingRequest('http://example.com/translation/tts', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore', languageCode: 'ja' }),
		});
		const ctx3 = createExecutionContext();
		await worker.fetch(req3, env, ctx3);
		await waitOnExecutionContext(ctx3);

		// Verify DB has 3 entries
		const db = createDb(env.words_db);
		const logs = await db.select().from(ttsLogs).execute();
		expect(logs.length).toBeGreaterThanOrEqual(3); // Might have logs from previous tests

		// Filter for our text
		const relevantLogs = logs.filter((l) => l.text === text);
		expect(relevantLogs.length).toBe(3);

		const langs = relevantLogs.map((l) => l.languageCode).sort();
		expect(langs).toEqual(['en-US', 'ja-JP', 'zh-CN']);
	});
});
