import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';
import { createDb } from '../src/db';
import { usageLogs } from '../src/db/schema';
import { eq } from 'drizzle-orm';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// This test actually calls the Gemini API.
// Run with: npx vitest run test/manual_gemini.test.ts
describe('Manual Gemini API Integration', () => {
	let validToken: string;
	const userId = 'manual_test_user';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		// We don't necessarily need to seed words/logs for this, unless we want to avoid 429 if we run it many times.
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('successfully translates text via Gemini', async () => {
		// "apple" from English to Chinese
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'apple',
				source_language: 'en',
				target_language: 'zh',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);

		console.log('--- Manual Translation Response Status:', response.status);
		expect(response.status).toBe(200);

		if (!response.body) throw new Error('No response body');

		// Consume stream
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let fullText = '';
		console.log('--- Start Reading Stream ---');
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			console.log('TEST_RECV:', chunk);
			fullText += chunk;
		}
		console.log('--- End Reading Stream ---');

		expect(fullText).toContain('data: ');
		expect(fullText).toContain('candidates');

		// Now wait for background tasks (DB save) to complete
		// Now wait for background tasks (DB save) to complete
		console.log('--- Waiting for Background Tasks (DB Save) ---');
		await waitOnExecutionContext(ctx);
		console.log('--- Background Tasks Complete ---');

		// Verify Usage Log
		const db = createDb(env.logs_db);
		const logs = await db.select().from(usageLogs).where(eq(usageLogs.userId, userId)).execute();

		expect(logs.length).toBeGreaterThan(0);

		const log = logs[0];
		expect(log.endpoint).toBe('text_translation'); // logUsage default endpoint for text
		expect(log.model).toBe('gemini-3-flash-preview');
		expect(log.inputTokens).toBeGreaterThan(0);
		expect(log.outputTokens).toBeGreaterThan(0);
		expect(log.costMicros).toBeGreaterThan(0);
	}, 30000);
});
