import { IRequest } from 'itty-router';
import { AuthenticatedRequest } from '../middleware/auth';
import { GeminiService } from '../services/gemini';

import { getLanguageName } from '../utils/languages';

const geminiService = new GeminiService();

import { logUsage } from '../models/usage';
import { PRICING_PER_1M, PRICING_PER_1M_LIVE } from '../config/pricing';

export async function handleTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	// Validate auth
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	const url = new URL(request.url);

	// 1. Check WebSocket Upgrade
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Please connect via WebSocket', { status: 426 });
	}

	// 2. Parse Params
	const params = url.searchParams;
	const sourceLangName = params.get('sourceLanguage') || 'English';
	const targetLangName = params.get('targetLanguage') || 'Chinese';

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
			return new Response('Failed to connect to Gemini backend', { status: 500 });
		}

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

		const closeHandler = async () => {
			if (logged) return;
			logged = true;

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
					await logUsage(env.logs_db, authReq.userId, modelNameShort, audio_input_tokens, audio_output_tokens, cost, 'live_translation');
				} else {
					// Fallback to standard Text Pricing if model not in MultiModal config found (unlikely)
				}
			}
		};

		worker.addEventListener('close', closeHandler);
		serverWebSocket.addEventListener('close', closeHandler);
		worker.addEventListener('error', closeHandler);
		serverWebSocket.addEventListener('error', closeHandler);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	} catch (err: any) {
		return new Response('Connection failed: ' + err.message, { status: 500 });
	}
}

export async function handleTextTranslation(request: IRequest, env: Env, ctx: ExecutionContext) {
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

	// Support both new (source_language) and old (source_lang) formats
	const text = body.text;
	const sourceLangCode = body.source_language || body.source_lang;
	const targetLangCode = body.target_language || body.target_lang;

	if (!text || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: text, source_language, target_language', { status: 400 });
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
	const sourceLangCode = body.source_language || body.source_lang;
	const targetLangCode = body.target_language || body.target_lang;
	const promptUser = body.prompt || '';

	if (!imageBase64 || !sourceLangCode || !targetLangCode) {
		return new Response('Missing required fields: image, source_language, target_language', { status: 400 });
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
