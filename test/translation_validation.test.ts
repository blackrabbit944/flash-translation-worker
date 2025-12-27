import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Language Code Validation', () => {
	let validToken: string;
	const userId = 'validation_test_user';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('Text Translation: rejects 3-char language codes', async () => {
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				text: 'hello',
				source_language: 'invalid-lang-code', // Invalid
				target_language: 'zh',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('must be a valid BCP-47');
	});

	it('Text Translation: accepts 3-char language codes (e.g. eng, fil)', async () => {
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer invalid` }, // Expect 401
			body: JSON.stringify({
				text: 'hello',
				source_language: 'eng', // Valid BCP-47
				target_language: 'fil', // Valid BCP-47
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Text Translation: accepts 5-char language codes (e.g. zh-TW)', async () => {
		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer invalid` }, // Expect 401 if passed validation
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: 'zh-TW', // Valid
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Text Translation: accepts 2-char language codes', async () => {
		// Mock Gemini Service to avoid real calls?
		// For validation check, we expect 400 if invalid. If valid, it proceeds to auth/quota/cache.
		// If it proceeds, it might fail later (e.g. cache miss -> auth -> real call).
		// We just want to check it DOES NOT return 400 for validation.
		// But if it proceeds to real call, it might return 500 or 200.
		// Let's use a 401 token to verify it PASSED validation but failed auth (or cache miss logic).
		// Wait, if we use valid token, it will try to call Google.
		// Let's use invalid token. If validation passes, it hits auth and returns 401.
		// If validation fails, it hits 400.

		const request = new IncomingRequest('http://example.com/translation/text', {
			method: 'POST',
			headers: { Authorization: `Bearer invalid` },
			body: JSON.stringify({
				text: 'hello',
				source_language: 'en',
				target_language: 'zh',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		// It should be 401 (Auth failed) NOT 400 (Validation failed)
		// Wait, handleTextTranslation checks Cache -> Auth.
		// If Cache Miss -> Auth -> 401.
		// Validation is BEFORE Cache.
		// So if valid, it checks cache (miss) -> Auth (401).
		expect(response.status).toBe(401);
	});

	it('Image Translation: rejects invalid language codes', async () => {
		const request = new IncomingRequest('http://example.com/translation/image', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				image: 'base64data',
				source_language: 'invalid-lang-code', // Invalid
				target_language: 'zh',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});
