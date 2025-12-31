import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { ttsLogs } from '../src/db/schema';
import { sign } from '../src/utils/jwt';
import { eq } from 'drizzle-orm';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('TTS2 API', () => {
	let validToken: string;
	const userId = 'test_user_tts2'; // Use different user for isolation

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

	it('Scenario C & B & A: New Request -> Processing -> Completed', async () => {
		const text = 'TTS2 Flow Test';
		const mockAudioData = 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; // Minimal WAV

		// Setup Mock
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
					promptTokenCount: 15,
					candidatesTokenCount: 150,
				},
			});

		// 1. First Request (Scenario C: New Request)
		// Should return 200 with Audio content
		const req1 = new IncomingRequest('http://example.com/translation/tts2', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore', languageCode: 'en' }),
		});
		const ctx1 = createExecutionContext();
		const res1 = await worker.fetch(req1, env, ctx1);

		expect(res1.status).toBe(200);
		expect(res1.headers.get('Content-Type')).toBe('audio/wav');
		const audioBuffer = await res1.arrayBuffer();
		expect(audioBuffer.byteLength).toBeGreaterThan(0);

		// Note: modifying logic to ensure database writes are awaited or checked properly.
		// ctx.waitUntil() promises are awaited by waitOnExecutionContext in cloudflare:test
		await waitOnExecutionContext(ctx1);

		// 2. Verify DB Status is Completed (after waitOnExecutionContext)
		const db = createDb(env.words_db);
		const logs = await db.select().from(ttsLogs).where(eq(ttsLogs.text, text)).execute();
		expect(logs.length).toBe(1);
		expect(logs[0].status).toBe('completed');
		expect(logs[0].url).toContain('r2://');

		// 3. Scenario A: Completed Request
		// Should return 200 with JSON URL
		const req2 = new IncomingRequest('http://example.com/translation/tts2', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text, voiceName: 'Kore', languageCode: 'en' }),
		});
		const ctx2 = createExecutionContext();
		const res2 = await worker.fetch(req2, env, ctx2);
		await waitOnExecutionContext(ctx2);

		expect(res2.status).toBe(200);
		expect(res2.headers.get('Content-Type')).toBe('application/json');
		const body2 = (await res2.json()) as any;
		expect(body2.audio_url).toBeDefined();

		// 4. Scenario B: Processing Request (Manual Test)
		// Manually insert a processing log
		const processingTextHash = 'processing_hash';
		await db
			.insert(ttsLogs)
			.values({
				id: 'proc_test',
				userId: userId,
				inputTokens: 0,
				outputTokens: 0,
				text: 'Processing Test',
				costMicros: 0,
				textHash: processingTextHash,
				voiceName: 'Kore',
				modelName: 'gemini-2.5-flash-preview-tts',
				languageCode: 'en-US',
				url: null,
				status: 'processing',
				createdAt: Date.now(),
			})
			.execute();

		// Update hash to match actual text hash logic
		const msgUint8 = new TextEncoder().encode('Processing Test');
		const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

		await db.update(ttsLogs).set({ textHash: hashHex }).where(eq(ttsLogs.id, 'proc_test')).execute();

		const req3 = new IncomingRequest('http://example.com/translation/tts2', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({ text: 'Processing Test', voiceName: 'Kore', languageCode: 'en' }),
		});
		const ctx3 = createExecutionContext();
		const res3 = await worker.fetch(req3, env, ctx3);
		await waitOnExecutionContext(ctx3);

		expect(res3.status).toBe(202);
		const body3 = (await res3.json()) as any;
		expect(body3.status).toBe('processing');
	});
});
