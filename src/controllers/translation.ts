import { IRequest } from 'itty-router';
import { AuthenticatedRequest, withAuth } from '../middleware/auth';
import { GeminiService } from '../services/gemini';

import { getLanguageName, normalizeLanguageTag } from '../utils/languages';

const geminiService = new GeminiService();

import { logUsage } from '../models/usage';
import { PRICING_PER_1M, PRICING_PER_1M_LIVE } from '../config/pricing';

function isValidLanguageCode(code: string): boolean {
	try {
		const locale = new Intl.Locale(code);
		return !!locale.language;
	} catch (e) {
		return false;
	}
}

export async function handleTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	// Validate auth
	if (!authReq.userId) {
		console.error('[Live] Unauthorized request');
		return new Response('Unauthorized', { status: 401 });
	}

	const url = new URL(request.url);
	const startTime = Date.now();

	console.log(`[Live] New connection request from ${authReq.userId}. Params: ${url.searchParams.toString()}`);

	// 1. Check WebSocket Upgrade
	if (request.headers.get('Upgrade') !== 'websocket') {
		console.error('[Live] Missing websocket upgrade header');
		return new Response('Please connect via WebSocket', { status: 426 });
	}

	// 2. Parse Params
	const params = url.searchParams;

	// Normalize and Validate
	let sourceLangCode = params.get('sourceLanguage');
	let targetLangCode = params.get('targetLanguage');

	if (sourceLangCode) sourceLangCode = normalizeLanguageTag(sourceLangCode);
	if (targetLangCode) targetLangCode = normalizeLanguageTag(targetLangCode);

	if ((sourceLangCode && !isValidLanguageCode(sourceLangCode)) || (targetLangCode && !isValidLanguageCode(targetLangCode))) {
		console.error(`[Live] Invalid language codes: ${sourceLangCode}, ${targetLangCode}`);
		return new Response('Invalid language code: must be a valid BCP-47 language tag (e.g. "en-US", "zh-TW").', { status: 400 });
	}

	const sourceLangName = getLanguageName(sourceLangCode || 'en');
	const targetLangName = getLanguageName(targetLangCode || 'zh');

	console.log(`[Live] Languages: ${sourceLangName} (${sourceLangCode}) <-> ${targetLangName} (${targetLangCode})`);

	// Validate params?
	// old.ts didn't really validate existence, just defaults.

	const voiceParam = params.get('voice');
	const allowedVoices = ['Kore'];
	const voiceName = voiceParam && allowedVoices.includes(voiceParam) ? voiceParam : 'Kore';

	// 3. System Prompt
	const systemPrompt = `
你是专业的双向实时语音翻译员。
你将听到 ${sourceLangName} 或 ${targetLangName} 的语音。
你必须检测语言并将其翻译成另一种语言（${sourceLangName} -> ${targetLangName} 或 ${targetLangName} -> ${sourceLangName}）。
仅输出翻译后的文本和音频。不要回复对话性文本，只提供翻译。

1.因此请你根据前后文进行翻译。
2.你听到的两种语言分别是2个不同身份的人在说话,所以你要理解这两个人的关系进行翻译.
3.如果说A语言,一定要翻译成B语言,无论说什么都不要理解回复,而是直接翻译.
4.如果说B语言,一定要翻译成A语言,无论说什么都不要理解回复,而是直接翻译.
`;

	const modelNameShort = 'gemini-2.5-flash-native-audio-preview-12-2025'; // Key for pricing
	const modelVersion = `models/${modelNameShort}`; // Full model string for API

	// 4. Setup Message
	const setupToGemini = {
		setup: {
			model: modelVersion,
			generationConfig: {
				responseModalities: ['AUDIO'],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: {
							voiceName: voiceName,
						},
					},
				},
			},
			systemInstruction: {
				parts: [{ text: systemPrompt }],
			},
			realtimeInputConfig: {
				automaticActivityDetection: {
					disabled: true,
					startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
					endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
					prefixPaddingMs: 20,
					silenceDurationMs: 1000,
				},
			},
			inputAudioTranscription: {},
			outputAudioTranscription: {},
		},
	};

	// 5. Build Target URL
	// Note: BidiGenerateContent is often v1alpha.
	const targetUrl =
		'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=' +
		env.GEMINI_API_KEY;

	try {
		console.log(`[Live] API Key used: ${env.GEMINI_API_KEY}`);
		console.log(`[Live] Connecting to Gemini: ${targetUrl.replace(env.GEMINI_API_KEY, '***')}`);
		const response = await fetch(targetUrl, {
			headers: {
				// Forward necessary headers? Or just basic?
				// old.ts forwarded request.headers.
				// But request.headers contains Host etc which might be wrong for Google.
				// Usually fetch handles host.
				// old.ts: headers: request.headers
				// I'll be careful. If it worked in old.ts, I'll trust it, but typically we filter headers.
				// However, Cloudflare's fetch might handle it.
			},
			// @ts-ignore
			webSocket: true,
		});

		const serverWebSocket = response.webSocket;
		if (!serverWebSocket) {
			console.error(`[Live] Failed to webSocket upgrade with Gemini. Status: ${response.status} ${response.statusText}`);
			const text = await response.text();
			console.error(`[Live] Error body: ${text}`);
			return new Response('Failed to connect to Gemini backend', { status: 500 });
		}

		console.log('[Live] Connected to Gemini. Accepting client connection.');

		// 6. WebSocket Pair
		const pair = new WebSocketPair();
		const client = pair[0];
		const worker = pair[1];
		worker.accept();
		serverWebSocket.accept();

		// 7. Send Setup
		serverWebSocket.send(JSON.stringify(setupToGemini));

		// Usage Tracking State
		let usageMetadata: {
			promptTokenCount: number;
			candidatesTokenCount: number;
			totalTokenCount: number;
			promptTokensDetails: {
				modality: 'AUDIO' | 'TEXT';
				tokenCount: number;
			}[];
			responseTokensDetails: {
				modality: 'AUDIO' | 'TEXT';
				tokenCount: number;
			}[];
		} = {
			promptTokenCount: 0,
			candidatesTokenCount: 0,
			totalTokenCount: 0,
			promptTokensDetails: [
				{
					modality: 'AUDIO',
					tokenCount: 0,
				},
				{
					modality: 'TEXT',
					tokenCount: 0,
				},
			],
			responseTokensDetails: [
				{
					modality: 'TEXT',
					tokenCount: 0,
				},
				{
					modality: 'AUDIO',
					tokenCount: 0,
				},
			],
		};

		// 8. Forwarding & Interception
		worker.addEventListener('message', (event) => {
			const data = event.data;
			if (typeof data === 'string') {
				try {
					const json = JSON.parse(data);
					if (json.setup) {
						// Drop client setup
						return;
					}
				} catch (e) {}
				serverWebSocket.send(data);
			} else {
				serverWebSocket.send(data);
			}
		});

		serverWebSocket.addEventListener('message', (event) => {
			const data = event.data;
			if (typeof data === 'string') {
				try {
					const json = JSON.parse(data);
					// Extract Usage
					if (json.usageMetadata) {
						usageMetadata = json.usageMetadata;
					}
					// Also check nested? Gemini docs vary.
					// Usually top level BidiGenerateContentResponse has usageMetadata.
				} catch (e) {}
			}
			worker.send(data);
		});

		// 9. Close & Log
		// We need to ensure we log only once.
		let logged = false;

		const closeHandler = async (evt: any) => {
			if (logged) return;
			logged = true;
			console.log('[Live] Connection closed.', evt && evt.type ? evt.type : '');

			try {
				worker.close();
			} catch {}
			try {
				serverWebSocket.close();
			} catch {}

			// Log Usage
			if (usageMetadata.promptTokenCount > 0 || usageMetadata.candidatesTokenCount > 0 || usageMetadata.totalTokenCount > 0) {
				const pricing = PRICING_PER_1M_LIVE[modelNameShort];
				let cost = 0;

				if (pricing) {
					// Detailed calculation
					let text_input_tokens = 0;
					let text_output_tokens = 0;
					let audio_input_tokens = 0;
					let audio_output_tokens = 0;

					const inputTokens = usageMetadata.promptTokensDetails.reduce((acc, detail) => {
						if (detail.modality === 'TEXT') {
							text_input_tokens += detail.tokenCount;
						} else if (detail.modality === 'AUDIO') {
							audio_input_tokens += detail.tokenCount;
						}
						return acc;
					}, 0);

					const outputTokens = usageMetadata.responseTokensDetails.reduce((acc, detail) => {
						if (detail.modality === 'TEXT') {
							text_output_tokens += detail.tokenCount;
						} else if (detail.modality === 'AUDIO') {
							audio_output_tokens += detail.tokenCount;
						}
						return acc;
					}, 0);

					const totalTokens = inputTokens + outputTokens;

					cost =
						pricing['audio_input'] * audio_input_tokens +
						pricing['audio_output'] * audio_output_tokens +
						pricing['text_input'] * text_input_tokens +
						pricing['text_output'] * text_output_tokens;

					// Use 'live_translation' as endpoint
					const endTime = Date.now();
					const durationSeconds = Math.ceil((endTime - startTime) / 1000);
					console.log(`[Live] Usage logged. Duration: ${durationSeconds}s, Cost: ${cost} micros`);
					await logUsage(
						env.logs_db,
						authReq.userId,
						modelNameShort,
						audio_input_tokens,
						audio_output_tokens,
						cost,
						'live_translation',
						undefined,
						durationSeconds
					);
				} else {
					// Fallback to standard Text Pricing if model not in MultiModal config found (unlikely)
				}
			}
		};

		worker.addEventListener('close', closeHandler);
		serverWebSocket.addEventListener('close', closeHandler);
		worker.addEventListener('error', (e) => {
			console.error('[Live] Worker WebSocket error:', e);
			closeHandler(e);
		});
		serverWebSocket.addEventListener('error', (e) => {
			console.error('[Live] Gemini WebSocket error:', e);
			closeHandler(e);
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	} catch (err: any) {
		console.error('[Live] Connection failed (catch block):', err);
		return new Response('Connection failed: ' + err.message, { status: 500 });
	}
}

export async function handleTextTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body first to check cache
	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	// Validate language codes
	// Support both new (source_language) and old (source_lang) formats
	// Normalize and Validate
	const text = body.text;
	let sourceLangCode = body.source_language || body.source_lang;
	let targetLangCode = body.target_language || body.target_lang;

	if (sourceLangCode) sourceLangCode = normalizeLanguageTag(sourceLangCode);
	if (targetLangCode) targetLangCode = normalizeLanguageTag(targetLangCode);

	if (!text || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: text, source_language, target_language', { status: 400 });
	}

	if (!isValidLanguageCode(sourceLangCode) || !isValidLanguageCode(targetLangCode)) {
		return new Response('Invalid language code: must be a valid BCP-47 language tag (e.g. "en-US", "zh-TW")', { status: 400 });
	}

	// 1. Check Cache (Allow quota exceeded users to access cached content)
	const cachedResult = await geminiService.findInCache(env, text, sourceLangCode, targetLangCode);
	if (cachedResult) {
		console.log('Cache hit for:', text);
		// Return cached result as SSE
		const mimicResponse = {
			candidates: [
				{
					content: { parts: [{ text: cachedResult }] },
				},
			],
		};
		const sseData = `data: ${JSON.stringify(mimicResponse)}\n\n`;

		return new Response(sseData, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}

	// 2. Cache Miss: Perform Authentication and Quota Check
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse;
	}

	// Auth success
	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	const sourceLangName = getLanguageName(sourceLangCode);
	const targetLangName = getLanguageName(targetLangCode);

	try {
		return await geminiService.translateAndStream(
			env,
			authReq.userId,
			text,
			sourceLangCode,
			targetLangCode,
			sourceLangName,
			targetLangName,
			ctx
		);
	} catch (error: any) {
		console.error('Translation Error:', error);
		return new Response(`Translation failed: ${error.message}`, { status: 500 });
	}
}

export async function handleImageTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	// Validate that auth middleware actually ran
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	const imageBase64 = body.image;
	const mimeType = body.mime_type || 'image/jpeg';
	let sourceLangCode = body.source_language || body.source_lang;
	let targetLangCode = body.target_language || body.target_lang;
	const promptUser = body.prompt || '';

	if (sourceLangCode) sourceLangCode = normalizeLanguageTag(sourceLangCode);
	if (targetLangCode) targetLangCode = normalizeLanguageTag(targetLangCode);

	if (!imageBase64 || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: image, source_language, target_language', { status: 400 });
	}

	if (!isValidLanguageCode(sourceLangCode) || !isValidLanguageCode(targetLangCode)) {
		return new Response('Invalid language code: must be a valid BCP-47 language tag (e.g. "en-US", "zh-TW")', { status: 400 });
	}

	// Validate Image Size (Approx 5MB Limit)
	// Base64 is ~1.33x size. 5MB * 1.33 = 6.65MB chars.
	// User requested max 1024x1024, usually < 1MB.
	// Let's set limit to 5,000,000 characters just to be safe but not too restrictive.
	if (imageBase64.length > 5_000_000) {
		return new Response('Image too large. Limit is approx 3MB.', { status: 413 });
	}

	const sourceLangName = getLanguageName(sourceLangCode);
	const targetLangName = getLanguageName(targetLangCode);

	try {
		// Log image translation request
		console.log(`[ImageTranslation] User ${authReq.userId} requested image translation. Size: ${imageBase64.length}`);

		return await geminiService.translateImageAndStream(
			env,
			authReq.userId,
			imageBase64,
			mimeType,
			promptUser,
			sourceLangCode,
			targetLangCode,
			sourceLangName,
			targetLangName,
			ctx
		);
	} catch (error: any) {
		console.error('Image Translation Error:', error);
		return new Response(`Image Translation failed: ${error.message}`, { status: 500 });
	}
}
