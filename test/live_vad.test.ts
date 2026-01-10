import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { handleTranslation } from '../src/controllers/translation';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Live Translation - VAD Parameter', () => {
	let validToken: string;
	const userId = 'vad_test_user';

	beforeAll(async () => {
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('sets disabled: false when vad=1 is provided', async () => {
		// Mock WebSocket
		const mockServerWs = {
			accept: vi.fn(),
			send: vi.fn(),
			addEventListener: vi.fn(),
			close: vi.fn(),
		};

		// Mock fetch to return the mock WebSocket
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
			status: 101,
			statusText: 'Switching Protocols',
			webSocket: mockServerWs,
		} as any);

		const request = new IncomingRequest('http://example.com/translation/live?vad=1', {
			headers: {
				Authorization: `Bearer ${validToken}`,
				Upgrade: 'websocket',
			},
		}) as any;
		request.userId = userId;

		const ctx = createExecutionContext();

		// We expect handleTranslation to return a 101 response with the client WebSocket
		const response = await handleTranslation(request, env, ctx);

		expect(response.status).toBe(101);
		expect(mockServerWs.accept).toHaveBeenCalled();

		// Check what was sent to the server WebSocket (Gemini)
		// The code sends the setup message immediately after accepting
		expect(mockServerWs.send).toHaveBeenCalledTimes(1);
		const sentMessage = JSON.parse(mockServerWs.send.mock.calls[0][0]);

		expect(sentMessage.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);

		fetchSpy.mockRestore();
	});

	it('sets disabled: true when vad param is missing', async () => {
		// Mock WebSocket
		const mockServerWs = {
			accept: vi.fn(),
			send: vi.fn(),
			addEventListener: vi.fn(),
			close: vi.fn(),
		};

		// Mock fetch
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
			status: 101,
			statusText: 'Switching Protocols',
			webSocket: mockServerWs,
		} as any);

		const request = new IncomingRequest('http://example.com/translation/live', {
			headers: {
				Authorization: `Bearer ${validToken}`,
				Upgrade: 'websocket',
			},
		}) as any;
		request.userId = userId;

		const ctx = createExecutionContext();
		const response = await handleTranslation(request, env, ctx);

		expect(response.status).toBe(101);
		expect(mockServerWs.send).toHaveBeenCalledTimes(1);
		const sentMessage = JSON.parse(mockServerWs.send.mock.calls[0][0]);

		expect(sentMessage.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);

		fetchSpy.mockRestore();
	});

	it('sets disabled: true when vad is not 1', async () => {
		// Mock WebSocket
		const mockServerWs = {
			accept: vi.fn(),
			send: vi.fn(),
			addEventListener: vi.fn(),
			close: vi.fn(),
		};

		// Mock fetch
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
			status: 101,
			statusText: 'Switching Protocols',
			webSocket: mockServerWs,
		} as any);

		const request = new IncomingRequest('http://example.com/translation/live?vad=0', {
			headers: {
				Authorization: `Bearer ${validToken}`,
				Upgrade: 'websocket',
			},
		}) as any;
		request.userId = userId;

		const ctx = createExecutionContext();
		const response = await handleTranslation(request, env, ctx);

		expect(response.status).toBe(101);
		expect(mockServerWs.send).toHaveBeenCalledTimes(1);
		const sentMessage = JSON.parse(mockServerWs.send.mock.calls[0][0]);

		expect(sentMessage.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);

		fetchSpy.mockRestore();
	});
});
