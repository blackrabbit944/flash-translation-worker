import { IRequest } from 'itty-router';
import { AuthenticatedRequest, withAuth } from '../middleware/auth';
import { GeminiService } from '../services/gemini';
import { CorrectionRequest, OpenRouterService } from '../services/openrouter';

import { getLanguageName, normalizeLanguageTag } from '../utils/languages';

const geminiService = new GeminiService();
const openRouterService = new OpenRouterService();

import { logUsage } from '../models/usage';
import { PRICING_PER_1M, PRICING_PER_1M_LIVE } from '../config/pricing';
import { aggregateUsage, calculateCostFromBreakdown } from '../utils/cost';

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
	const targetUrl =
		'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
		env.GEMINI_API_KEY;

	try {
		console.log(`[Live] API Key used: ${env.GEMINI_API_KEY}`);
		console.log(`[Live] Connecting to Gemini: ${targetUrl.replace(env.GEMINI_API_KEY, '***')}`);

		const proxyHeaders = new Headers(request.headers);

		// 2. 剔除会导致 Google 混淆的鉴权头
		proxyHeaders.delete('Authorization');
		proxyHeaders.delete('Host'); // 最好也把 Host 删掉，让 fetch 自动生成

		const response = await fetch(targetUrl, {
			headers: proxyHeaders,
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
		// Store all usage events for final logging
		const allUsageEvents: any[] = [];

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

					// Debug: Log all keys in the message to see what we are getting
					// console.log('[Live] Message Keys:', Object.keys(json));

					// Extract Usage
					if (json.usageMetadata) {
						console.log('[Live] Received usage update:', JSON.stringify(json.usageMetadata));
						usageMetadata = json.usageMetadata;
						allUsageEvents.push(json.usageMetadata);
					}
					// Also check nested? Gemini docs vary.
					// Usually top level BidiGenerateContentResponse has usageMetadata.
				} catch (e) {}
			} else {
				// Binary data (audio) or potentially JSON-as-Binary
				try {
					// Fallback: Gemini sometimes sends JSON messages as binary frames (ArrayBuffer)
					// Try to decode and parse
					if (data instanceof ArrayBuffer) {
						const text = new TextDecoder().decode(data);
						if (text.startsWith('{') && text.includes('usageMetadata')) {
							console.log('[Live] Decoded binary frame as text, checking for usage...');
							const json = JSON.parse(text);
							if (json.usageMetadata) {
								console.log('[Live] Received usage update (from binary):', JSON.stringify(json.usageMetadata));
								usageMetadata = json.usageMetadata;
								allUsageEvents.push(json.usageMetadata);
							}
						}
					}
				} catch (e) {
					// Not JSON or decoding failed, treat as normal audio binary
				}
				// console.log('[debug]mesage中二进制的data', data);
			}
			worker.send(data);
		});

		// 9. Close & Log
		// We need to ensure we log only once.
		let logged = false;

		const closeHandler = async (evt: any) => {
			if (logged) return;
			logged = true;

			if (evt instanceof ErrorEvent || (evt && evt.error)) {
				console.error('[Live] Connection Error Details:', evt.message || evt.error);
			}

			console.log('[Live] Connection closing. Source:', evt && evt.type ? evt.type : 'unknown');

			try {
				worker.close(1000, 'Work complete');
			} catch {}
			try {
				serverWebSocket.close(1000, 'Work complete');
			} catch {}

			// Log Usage
			// Log Usage
			const compiledUsage = aggregateUsage(allUsageEvents);
			console.log(`[Live] Aggregated Usage:`, JSON.stringify(compiledUsage));

			if (compiledUsage.input.total > 0 || compiledUsage.output.total > 0) {
				const cost = calculateCostFromBreakdown(modelNameShort, compiledUsage, PRICING_PER_1M_LIVE);

				if (cost > 0) {
					const audio_input_tokens = compiledUsage.input.audio;
					const audio_output_tokens = compiledUsage.output.audio;

					// Use 'live_translation' as endpoint
					const endTime = Date.now();
					const durationSeconds = Math.ceil((endTime - startTime) / 1000);

					// Detailed Accumulation Logging
					console.log('--- Session Usage Summary ---');
					console.log(`Total Usage Updates Received: ${allUsageEvents.length}`);
					console.log(`Duration: ${durationSeconds}s`);
					console.log(`Aggregated Breakdown:`, JSON.stringify(compiledUsage, null, 2));

					console.log(`Accumulated (Sum) Prompt Tokens: ${compiledUsage.input.total}`);
					console.log(`Accumulated (Sum) Response Tokens: ${compiledUsage.output.total}`);
					console.log('--- End Summary ---');

					console.log(`[Live] Usage logged. Duration: ${durationSeconds}s, Cost: ${cost} micros`);

					// Critical: Wrap async DB write in ctx.waitUntil
					ctx.waitUntil(
						logUsage(
							env.logs_db,
							authReq.userId,
							modelNameShort,
							audio_input_tokens,
							audio_output_tokens,
							cost,
							'live_translation',
							undefined,
							durationSeconds,
							authReq.membershipTier
						).catch((err) => console.error('[Live] Failed to log usage:', err))
					);
				} else {
					// Fallback to standard Text Pricing if model not in MultiModal config found (unlikely)
				}
			} else {
				console.log('[Live] No usage to log (Token usage is 0). This usually means failure before any content generation.');
			}
		};

		worker.addEventListener('close', closeHandler);
		serverWebSocket.addEventListener('close', closeHandler);
		worker.addEventListener('error', (e) => {
			const msg = (e as any).message || (e as any).error || JSON.stringify(e);
			console.error(`[Live] Worker WebSocket error: ${msg}`);
			closeHandler(e);
		});
		serverWebSocket.addEventListener('error', (e) => {
			const msg = (e as any).message || (e as any).error || JSON.stringify(e);
			console.error(`[Live] Gemini WebSocket error: ${msg}`);
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

export async function handleLongTextTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body
	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	console.log('[LongText] Request Body:', JSON.stringify(body));

	const text = body.text;
	let sourceLangCode = body.source_language || body.source_lang;
	let targetLangCode = body.target_language || body.target_lang;

	if (sourceLangCode) sourceLangCode = normalizeLanguageTag(sourceLangCode);
	if (targetLangCode) targetLangCode = normalizeLanguageTag(targetLangCode);

	if (!text || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: text, source_language, target_language', { status: 400 });
	}

	if (!isValidLanguageCode(sourceLangCode) || !isValidLanguageCode(targetLangCode)) {
		return new Response('Invalid language code: must be a valid BCP-47 language tag', { status: 400 });
	}

	// Auth Check
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse;
	}

	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	const sourceLangName = getLanguageName(sourceLangCode);
	const targetLangName = getLanguageName(targetLangCode);

	try {
		return await geminiService.translateLongTextAndStream(
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
		console.error('Long Text Translation Error:', error);
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

export async function handleRecognition(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	// Input: audio (base64), source_language, target_language
	const audioBase64 = body.audio;
	let sourceLangCode = body.source_language || body.source_lang;
	let targetLangCode = body.target_language || body.target_lang;

	if (sourceLangCode) sourceLangCode = normalizeLanguageTag(sourceLangCode);
	if (targetLangCode) targetLangCode = normalizeLanguageTag(targetLangCode);

	if (!audioBase64 || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: audio, source_language, target_language', { status: 400 });
	}

	if (!isValidLanguageCode(sourceLangCode) || !isValidLanguageCode(targetLangCode)) {
		return new Response('Invalid language code', { status: 400 });
	}

	const sourceLangName = getLanguageName(sourceLangCode);
	const targetLangName = getLanguageName(targetLangCode);

	try {
		console.log(`[Recognition] User ${authReq.userId} requested intent recognition.`);
		const recognizedText = await geminiService.recognizeIntent(
			env,
			authReq.userId,
			audioBase64,
			sourceLangCode,
			targetLangCode,
			sourceLangName,
			targetLangName
		);

		if (!recognizedText) {
			return new Response('Failed to recognize intent', { status: 500 });
		}

		// Return simple JSON
		return new Response(JSON.stringify({ content: recognizedText }), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error: any) {
		console.error('Recognition Error:', error);
		return new Response(`Recognition failed: ${error.message}`, { status: 500 });
	}
}

export async function handleClassifyText(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body
	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	const text = body.text;

	if (!text) {
		return new Response('Missing required field: text', { status: 400 });
	}

	// Authentication and Quota Check
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse;
	}

	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	try {
		const result = await geminiService.classifyText(env, authReq.userId, text, ctx);
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error: any) {
		console.error('Classification Error:', error);
		return new Response(`Classification failed: ${error.message}`, { status: 500 });
	}
}

export async function handleWordTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body
	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

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

	// 1. Check Cache First (before auth to save quota)
	const cachedResult = await geminiService.findInCache(env, text, sourceLangCode, targetLangCode);

	if (cachedResult) {
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
		return await geminiService.translateWordAndStream(
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
		console.error('Word Translation Error:', error);
		return new Response(`Word translation failed: ${error.message}`, { status: 500 });
	}
}

export async function handleInputCorrection(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body
	let body;
	try {
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	const { original, translated, sourceLang, targetLang, original_input, translated_output, source_language, target_language } = body;

	const finalOriginal = original || original_input;
	const finalTranslated = translated || translated_output;
	const finalSourceLang = sourceLang || source_language;
	const finalTargetLang = targetLang || target_language;

	// Validate required fields
	if (!finalOriginal || !finalTranslated || !finalSourceLang || !finalTargetLang) {
		return new Response('Missing required fields: original_input, translated_output, source_language, target_language', { status: 400 });
	}

	// Auth check (Optional: decide if correction needs auth, assuming yes based on other endpoints)
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse;
	}

	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	try {
		const correctedText = await openRouterService.correctInput(
			env,
			{
				original: finalOriginal,
				translated: finalTranslated,
				sourceLang: finalSourceLang,
				targetLang: finalTargetLang,
			},
			authReq.userId,
			ctx
		);

		// Mimic Gemini response structure
		const responseData = {
			candidates: [
				{
					content: {
						parts: [
							{
								text: correctedText,
							},
						],
					},
				},
			],
		};

		const sseData = `data: ${JSON.stringify(responseData)}\n\n`;

		return new Response(sseData, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	} catch (error: any) {
		console.error('Input Correction Error:', error);
		return new Response(`Input Correction failed: ${error.message}`, { status: 500 });
	}
}
