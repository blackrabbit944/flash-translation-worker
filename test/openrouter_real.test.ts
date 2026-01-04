import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { OpenRouterService } from '../src/services/openrouter';

/**
 * Real OpenRouter API Integration Tests
 *
 * These tests call the actual OpenRouter API and are skipped by default.
 * To run them, remove the .skip and ensure OPENROUTER_API_KEY is set in your environment.
 *
 * Run with: pnpm test -- openrouter_real
 */

describe.skip('OpenRouter Real API Integration', () => {
	const openRouterService = new OpenRouterService();

	it('successfully translates a word using real OpenRouter API', async () => {
		const text = 'hello';
		const sourceLang = 'zh-CN';
		const targetLang = 'en-US';
		const sourceLangName = '中文';
		const targetLangName = 'English';

		const response = await openRouterService.translateWord(env, text, sourceLang, targetLang, sourceLangName, targetLangName);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		// Read the streaming response
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let fullText = '';

		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				fullText += decoder.decode(value, { stream: true });
			}
		}

		console.log('OpenRouter Word Translation Response:', fullText);

		// Verify SSE format
		expect(fullText).toContain('data: ');

		// Parse SSE events
		const lines = fullText.split('\n').filter((line: string) => line.startsWith('data: '));
		expect(lines.length).toBeGreaterThan(0);

		// Verify Gemini-compatible format
		let hasValidContent = false;
		for (const line of lines) {
			const jsonStr = line.slice(6); // Remove 'data: '
			const data = JSON.parse(jsonStr);

			// Check for Gemini format
			if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
				hasValidContent = true;
				console.log('Content chunk:', data.candidates[0].content.parts[0].text);
			}
		}

		expect(hasValidContent).toBe(true);
	}, 30000); // 30 second timeout for real API call

	it('successfully translates long text using real OpenRouter API', async () => {
		const text = 'This is a longer text that needs translation. It contains multiple sentences.';
		const sourceLang = 'zh-CN';
		const targetLang = 'en-US';
		const sourceLangName = '中文';
		const targetLangName = 'English';

		const response = await openRouterService.translateLongText(env, text, sourceLang, targetLang, sourceLangName, targetLangName);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let fullText = '';

		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				fullText += decoder.decode(value, { stream: true });
			}
		}

		console.log('OpenRouter Long Text Translation Response:', fullText);
		expect(fullText).toContain('data: ');
	}, 30000);

	it('successfully classifies text using real OpenRouter API', async () => {
		const testCases = [
			{ text: 'hello', expected: 'word' },
			{ text: 'This is a sentence.', expected: 'sentence' },
			{ text: 'This is a paragraph. It has multiple sentences. Each one is separate.', expected: 'multiple_sentences' },
		];

		for (const testCase of testCases) {
			const result = await openRouterService.classifyText(env, testCase.text);

			console.log(`Text: "${testCase.text}" -> Type: ${result.type}`);
			expect(result.type).toBe(testCase.expected);
		}
	}, 30000);

	it('successfully translates image using real OpenRouter API', async () => {
		// Simple 1x1 red pixel PNG in base64
		const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
		const mimeType = 'image/png';
		const promptUser = 'Describe this image';
		const sourceLang = 'zh-CN';
		const targetLang = 'en-US';
		const sourceLangName = '中文';
		const targetLangName = 'English';

		const response = await openRouterService.translateImage(
			env,
			testImageBase64,
			mimeType,
			promptUser,
			sourceLang,
			targetLang,
			sourceLangName,
			targetLangName
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');

		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let fullText = '';

		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				fullText += decoder.decode(value, { stream: true });
			}
		}

		console.log('OpenRouter Image Translation Response:', fullText);
		expect(fullText).toContain('data: ');
	}, 30000);
});
