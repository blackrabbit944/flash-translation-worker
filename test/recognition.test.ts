import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { usageLogs } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Intent Recognition API', () => {
	let validToken: string;
	const userId = 'test_user_recog';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
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
		const request = new IncomingRequest('http://example.com/translation/recognition', {
			method: 'POST',
			body: JSON.stringify({
				audio: 'dGVzdA==', // test
				source_language: 'en',
				target_language: 'es',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('rejects missing audio', async () => {
		const request = new IncomingRequest('http://example.com/translation/recognition', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				source_language: 'en',
				target_language: 'es',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required fields');
	});

	it('successfully recognizes intent and logs usage', async () => {
		const expectedContent = 'Hello world';
		const modelName = 'gemini-2.5-flash';

		fetchMock
			.get('https://generativelanguage.googleapis.com')
			.intercept({
				path: new RegExp(`/v1beta/models/${modelName}:generateContent`),
				method: 'POST',
			})
			.reply(200, {
				candidates: [
					{
						content: {
							parts: [
								{
									text: JSON.stringify({ content: expectedContent }),
								},
							],
						},
					},
				],
				usageMetadata: {
					promptTokenCount: 575,
					candidatesTokenCount: 20,
					totalTokenCount: 686,
					promptTokensDetails: [
						{ modality: 'TEXT', tokenCount: 396 },
						{ modality: 'AUDIO', tokenCount: 179 },
					],
					thoughtsTokenCount: 91,
				},
			});

		const request = new IncomingRequest('http://example.com/translation/recognition', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				audio: 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', // Minimal WAV
				source_language: 'en',
				target_language: 'es',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');

		const body = (await response.json()) as any;
		expect(body.content).toBe(expectedContent);

		// Verify DB Log
		const db = createDb(env.logs_db);
		const logs = await db.select().from(usageLogs).execute();

		// Filter for our user and endpoint
		const relevantLogs = logs.filter((l) => l.userId === userId && l.endpoint === 'intent_recognition');
		expect(relevantLogs.length).toBe(1);
		expect(relevantLogs[0].inputTokens).toBe(575);
		expect(relevantLogs[0].outputTokens).toBe(111); // API returns candidatesTokenCount as outputTokens argument usually, but our logic passes usageMetadata.candidatesTokenCount

		// Wait, logUsage argument 5 is outputTokens. In code: logUsage(..., json.usageMetadata.candidatesTokenCount, ...)
		// But cost calculation includes thoughts!

		// Cost Calc:
		// Text Input: 396 * 0.3 = 118.8
		// Audio Input: 179 * 1 = 179
		// Output: (20 + 91 = 111) * 2.5 = 277.5
		// Total: 118.8 + 179 + 277.5 = 575.3 -> 576

		expect(relevantLogs[0].costMicros).toBe(576);
		expect(relevantLogs[0].model).toBe(modelName);
	});
});
