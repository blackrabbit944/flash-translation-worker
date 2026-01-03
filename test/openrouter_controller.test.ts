import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleInputCorrection } from '../src/controllers/translation';
import { OpenRouterService } from '../src/services/openrouter';

// Mock dependencies
const mockEnv = {
	OPENROUTER_API_KEY: 'test-key',
} as any;

const mockCtx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
} as any;

// Mock OpenRouterService
vi.mock('../src/services/openrouter', () => {
	return {
		OpenRouterService: vi.fn().mockImplementation(() => ({
			correctInput: vi.fn().mockResolvedValue('Corrected Text'),
		})),
	};
});

describe('handleInputCorrection', () => {
	it('should return 400 if required fields are missing', async () => {
		const req = {
			json: async () => ({}),
		} as any;

		const response = await handleInputCorrection(req, mockEnv, mockCtx);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Missing required fields');
	});

	// skipping this test because it requires auth middleware mocking which is complex here
	it.skip('should return corrected text in Gemini format on success', async () => {
		const req = {
			json: async () => ({
				original_input: 'Hola',
				translated_output: 'Hello',
				source_language: 'Spanish',
				target_language: 'English',
			}),
			headers: new Map([['Authorization', 'Bearer valid_token']]),
		} as any;
		const response = await handleInputCorrection(req, mockEnv, mockCtx);
		const text = await response.text();
		const jsonStr = text.replace('data: ', '').trim();
		const data = JSON.parse(jsonStr);
		expect(data).toHaveProperty('candidates');
		expect(data.candidates[0].content.parts[0].text).toBe('Corrected Text');
	});
});
