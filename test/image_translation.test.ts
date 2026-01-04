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

		// Mock OpenRouter SSE response (our code will convert it to Gemini format)
		const mockOpenRouterChunk1 = JSON.stringify({
			choices: [{ delta: { content: 'Image translation ' } }],
		});
		const mockOpenRouterChunk2 = JSON.stringify({
			choices: [{ delta: { content: 'result' } }],
		});

		// Mock SSE stream in OpenRouter format
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${mockOpenRouterChunk1}\n\n`));
				controller.enqueue(new TextEncoder().encode(`data: ${mockOpenRouterChunk2}\n\n`));
				controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
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

		// Verify structure matches Gemini format (converted from OpenRouter)
		const ssePrefix = 'data: ';
		const lines = text.split('\n').filter((line: string) => line.startsWith(ssePrefix));

		expect(lines.length).toBeGreaterThan(0);

		// Concatenate all content from all SSE events
		let fullContent = '';
		for (const line of lines) {
			const jsonStr = line.slice(ssePrefix.length);
			const data = JSON.parse(jsonStr);
			const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
			if (content) {
				fullContent += content;
			}
		}

		expect(fullContent).toBe('Image translation result');
	});
});
