import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Image Translation API', () => {
	let validToken: string;
	const userId = 'test_user_image_trans';

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

	it('returns correct SSE format with buffered response (mocked fetch)', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch');
		const mockGeminiResponse = JSON.stringify({
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
			candidates: [
				{
					content: { parts: [{ text: 'Image translation result' }] },
				},
			],
		});

		// Mock SSE stream from Gemini
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${mockGeminiResponse}\n\n`));
				controller.close();
			},
		});

		fetchSpy.mockResolvedValueOnce(new Response(stream));

		const request = new IncomingRequest('http://example.com/translation/image', {
			method: 'POST',
			headers: { Authorization: `Bearer ${validToken}` },
			body: JSON.stringify({
				image: 'base64data',
				mime_type: 'image/jpeg',
				source_language: 'en',
				target_language: 'es',
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const text = await response.text();
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Verify structure matches mimicResponse
		// data: {"candidates":[{"content":{"parts":[{"text":"...
		const ssePrefix = 'data: ';
		const dataLine = text.split('\n').find((line: string) => line.startsWith(ssePrefix));
		expect(dataLine).toBeDefined();

		const jsonStr = dataLine!.slice(ssePrefix.length);
		const data = JSON.parse(jsonStr);
		const innerText = data.candidates[0].content.parts[0].text;

		expect(innerText).toBe('Image translation result');
	});
});
