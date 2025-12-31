import { IRequest } from 'itty-router';
import { AuthenticatedRequest, withAuth } from '../middleware/auth';
import {
	logTts,
	findTtsLogByHash,
	findLatestTtsLogByTextHash,
	findTtsRequest,
	createPendingTtsLog,
	updateTtsLogStatus,
} from '../models/tts';
import { logUsage } from '../models/usage';
import { PRICING_PER_1M } from '../config/pricing';
import { normalizeLanguageTag } from '../utils/languages';
import { calculateCost } from '../utils/cost';

async function calculateHash(text: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleTtsPreview(request: IRequest, env: Env, ctx: ExecutionContext) {
	const url = new URL(request.url);
	const hash = url.searchParams.get('hash');

	if (!hash) {
		return new Response('Missing hash', { status: 400 });
	}

	const log = await findLatestTtsLogByTextHash(env.words_db, hash);

	if (!log || !log.url) {
		return new Response('Not found', { status: 404 });
	}

	if (!log.url.startsWith('r2://')) {
		// If it's a regular URL, redirect? Or we only support R2 preview?
		// User said: "local has no network URL", implying R2 local storage.
		// If storedUrl is not r2 scheme, we might just return it?
		// But let's assume valid R2 keys.
		return new Response('Invalid resource type', { status: 400 });
	}

	const key = log.url.substring(5); // Remove r2://
	const object = await env.TTS_BUCKET.get(key);

	if (!object) {
		return new Response('Object not found in R2', { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Content-Type', 'audio/wav'); // Force audio/wav for preview

	return new Response(object.body, {
		headers,
	});
}

export async function handleTts(request: IRequest, env: Env, ctx: ExecutionContext) {
	// Parse body first to check cache
	let body;
	try {
		// Clone request to read body, as we might need to read it again or pass it to withAuth (though withAuth reads headers)
		// Actually, request.json() consumes the body.
		// If we consume it here, we pass the data.
		body = (await request.json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	let { text, voiceName = 'Kore', languageCode } = body;

	if (languageCode) {
		languageCode = normalizeLanguageTag(languageCode);
	}

	if (!text) {
		return new Response('Missing required fields', { status: 400 });
	}

	if (voiceName !== 'Kore') {
		return new Response('Only "Kore" voice is supported currently', { status: 400 });
	}

	const modelNameShort = 'gemini-2.5-flash-preview-tts';
	const textHash = await calculateHash(text);

	// Check Cache - allow unauthenticated access for cached content
	const cachedLog = await findTtsLogByHash(env.words_db, textHash, voiceName, modelNameShort, languageCode);
	if (cachedLog && cachedLog.url) {
		let audioUrl;
		if (env.ENVIRONMENT === 'production') {
			// Production: Use R2 public domain
			// storedUrl is r2://key, we need just the key
			const key = cachedLog.url.startsWith('r2://') ? cachedLog.url.substring(5) : cachedLog.url;
			audioUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;
		} else {
			// Dev: Use local preview endpoint
			audioUrl = `https://kiwi-api-local.jianda.com/tts/preview?hash=${textHash}`;
		}

		return new Response(
			JSON.stringify({
				audio_url: audioUrl,
			}),
			{
				headers: {
					'Content-Type': 'application/json',
				},
			}
		);
	}

	// Cache Miss: Perform Authentication and Quota Check
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse; // Return error response (401, 429, etc.)
	}

	// Auth success, proceed
	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		// Should have been caught by withAuth, but double check
		return new Response('Unauthorized', { status: 401 });
	}

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelNameShort}:generateContent?key=${env.GEMINI_API_KEY}`;

	const prompt = `
Please generate speech for the following text.
The text is expected to be in language code: "${languageCode || 'unknown'}".
However, this language code is only a reference. If the text appears to be in a different language, please ignore the reference and speak in the detected language.
Text to speak: "${text}"
`;

	const payload = {
		contents: [
			{
				parts: [
					{
						text: prompt,
					},
				],
			},
		],
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
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return new Response(`Gemini API Error: ${response.status} ${errorText}`, { status: response.status });
		}

		const data = (await response.json()) as any;

		// Extract Audio
		// Structure: candidates[0].content.parts[0].inlineData.data
		const candidate = data.candidates?.[0];
		const part = candidate?.content?.parts?.[0];

		if (!part || !part.inlineData || !part.inlineData.data) {
			return new Response('No audio generated', { status: 500 });
		}

		const base64Audio = part.inlineData.data;

		// Decode Base64
		const binaryString = atob(base64Audio);
		const len = binaryString.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}

		// Calculate Usage & Cost
		const usage = data.usageMetadata || {};

		console.log('TTS Usage Metadata:', usage);

		const result = calculateCost(modelNameShort, usage, PRICING_PER_1M);

		// Store in R2
		const fileId = crypto.randomUUID();
		const key = `tts/${authReq.userId}/${fileId}.wav`; // Using .wav even if it's raw PCM?
		// User said: "base64 --decode > out.pcm ... ffmpeg ... > out.wav".
		// Gemini returns PCM 24kHz usually? Or WAV?
		// Verification: The user provided curl example pipes to `out.pcm` and uses ffmpeg to wav.
		// So it is likely Raw PCM 24kHz 16-bit Mono (common for Gemini).
		// If I assume it's PCM, and I returning it, the client might need to wrap it.
		// BUT the user says "ffmpeg -f ... -i out.pcm out.wav".
		// If I return the raw bytes, it's PCM.
		// If I want to be helpful, I could try to add a WAV header?
		// Adding a WAV header in JS is easy if I know the sample rate (24000) and format (s16le).
		// Let's add a WAV header to make it usable directly.

		const wavHeader = createWavHeader(bytes.length, 24000, 1, 16);
		const wavFile = new Uint8Array(wavHeader.length + bytes.length);
		wavFile.set(wavHeader);
		wavFile.set(bytes, wavHeader.length);

		let storedUrl = '';
		if (env.TTS_BUCKET) {
			await env.TTS_BUCKET.put(key, wavFile, {
				httpMetadata: {
					contentType: 'audio/wav',
				},
			});
			// Reserve URL (e.g., if we had a public domain)
			// For now, we store the key or a hypothetical URL
			storedUrl = `r2://${key}`;
		}

		// Log DB
		ctx.waitUntil(
			Promise.all([
				logTts(env.words_db, {
					userId: authReq.userId,
					inputTokens: result.input.total,
					outputTokens: result.output.total,
					text,
					costMicros: result.cost,
					textHash: await calculateHash(text),
					voiceName,
					modelName: modelNameShort,
					languageCode,
					url: storedUrl,
				}).catch((err) => console.error('LogTts Error', err)),
				logUsage(env.logs_db, authReq.userId, modelNameShort, result.input.total, result.output.total, result.cost, 'tts').catch((err) =>
					console.error('LogUsage TTS Error', err)
				),
			])
		);

		let audioUrl;
		if (env.ENVIRONMENT === 'production') {
			const key = storedUrl.startsWith('r2://') ? storedUrl.substring(5) : storedUrl;
			audioUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;
		} else {
			audioUrl = `https://kiwi-api-local.jianda.com/tts/preview?hash=${await calculateHash(text)}`;
		}

		return new Response(
			JSON.stringify({
				audio_url: audioUrl,
			}),
			{
				headers: {
					'Content-Type': 'application/json',
				},
			}
		);
	} catch (error: any) {
		console.error('TTS Error:', error);
		return new Response(`TTS failed: ${error.message}`, { status: 500 });
	}
}

function createWavHeader(dataLength: number, sampleRate: number, numChannels: number, bitsPerSample: number): Uint8Array {
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const byteRate = sampleRate * blockAlign;
	const buffer = new ArrayBuffer(44);
	const view = new DataView(buffer);

	// RIFF string
	writeString(view, 0, 'RIFF');
	// File size (data + 36)
	view.setUint32(4, 36 + dataLength, true);
	// WAVE string
	writeString(view, 8, 'WAVE');
	// fmt string
	writeString(view, 12, 'fmt ');
	// Subchunk1Size
	view.setUint32(16, 16, true);
	// AudioFormat (1 = PCM)
	view.setUint16(20, 1, true);
	// NumChannels
	view.setUint16(22, numChannels, true);
	// SampleRate
	view.setUint32(24, sampleRate, true);
	// ByteRate
	view.setUint32(28, byteRate, true);
	// BlockAlign
	view.setUint16(32, blockAlign, true);
	// BitsPerSample
	view.setUint16(34, bitsPerSample, true);
	// data string
	writeString(view, 36, 'data');
	// Subchunk2Size
	view.setUint32(40, dataLength, true);

	return new Uint8Array(buffer);
}

function writeString(view: DataView, offset: number, string: string) {
	for (let i = 0; i < string.length; i++) {
		view.setUint8(offset + i, string.charCodeAt(i));
	}
}

export async function handleTts2(request: IRequest, env: Env, ctx: ExecutionContext) {
	// 1. Auth & Input Handling
	// Parse body first to check parameters
	let body;
	try {
		body = (await request.clone().json()) as any;
	} catch (e) {
		return new Response('Invalid JSON', { status: 400 });
	}

	let { text, voiceName = 'Kore', languageCode } = body;
	if (languageCode) {
		languageCode = normalizeLanguageTag(languageCode);
	}
	if (!text) {
		return new Response('Missing required fields', { status: 400 });
	}
	if (voiceName !== 'Kore') {
		return new Response('Only "Kore" voice is supported currently', { status: 400 });
	}

	const modelNameShort = 'gemini-2.5-flash-preview-tts';
	const textHash = await calculateHash(text); // calculateHash is in scope

	// 2. Check DB Status
	// Need to import findTtsRequest from models/tts
	const existingLog = await findTtsRequest(env.words_db, textHash, voiceName, modelNameShort, languageCode);

	if (existingLog) {
		// Scenario A: Completed -> Return URL
		if (existingLog.status === 'completed' && existingLog.url) {
			let audioUrl;
			if (env.ENVIRONMENT === 'production') {
				const key = existingLog.url.startsWith('r2://') ? existingLog.url.substring(5) : existingLog.url;
				audioUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;
			} else {
				audioUrl = `https://kiwi-api-local.jianda.com/tts/preview?hash=${textHash}`;
				// Fallback for dev if no valid public domain
			}
			return new Response(JSON.stringify({ audio_url: audioUrl }), {
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			});
		}

		// Scenario B: Processing -> Return 202
		if (existingLog.status === 'processing' || (existingLog.status === 'completed' && !existingLog.url)) {
			return new Response(JSON.stringify({ status: 'processing', message: 'Generating audio, please wait.' }), {
				status: 202,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		// If failed, proceed to retry (Scenario C)
	}

	// Scenario C: New Request
	// Auth Check
	const authResponse = await withAuth(request, env, ctx);
	if (authResponse) {
		return authResponse;
	}
	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) return new Response('Unauthorized', { status: 401 });

	// Insert Pending Log
	// Need to import createPendingTtsLog, updateTtsLogStatus
	await createPendingTtsLog(env.words_db, {
		userId: authReq.userId,
		text,
		textHash,
		voiceName,
		modelName: modelNameShort,
		languageCode,
	});

	// Call Gemini
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelNameShort}:generateContent?key=${env.GEMINI_API_KEY}`;
	const prompt = `
Please generate speech for the following text.
The text is expected to be in language code: "${languageCode || 'unknown'}".
However, this language code is only a reference. If the text appears to be in a different language, please ignore the reference and speak in the detected language.
Text to speak: "${text}"
`;

	const payload = {
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: {
			responseModalities: ['AUDIO'],
			speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } },
		},
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const errorText = await response.text();
			// Update DB to failed
			await updateTtsLogStatus(env.words_db, textHash, {
				status: 'failed',
				inputTokens: 0,
				outputTokens: 0,
				costMicros: 0,
			});
			return new Response(`Gemini API Error: ${response.status} ${errorText}`, { status: response.status });
		}

		const data = (await response.json()) as any;
		const candidate = data.candidates?.[0];
		const part = candidate?.content?.parts?.[0];

		if (!part || !part.inlineData || !part.inlineData.data) {
			await updateTtsLogStatus(env.words_db, textHash, {
				status: 'failed',
				inputTokens: 0,
				outputTokens: 0,
				costMicros: 0,
			});
			return new Response('No audio generated', { status: 500 });
		}

		const base64Audio = part.inlineData.data;
		const binaryString = atob(base64Audio);
		const len = binaryString.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}

		const usage = data.usageMetadata || {};
		const costResult = calculateCost(modelNameShort, usage, PRICING_PER_1M);
		const fileId = crypto.randomUUID();
		const key = `tts/${authReq.userId}/${fileId}.wav`;

		// Create WAV
		const wavHeader = createWavHeader(bytes.length, 24000, 1, 16);
		const wavFile = new Uint8Array(wavHeader.length + bytes.length);
		wavFile.set(wavHeader);
		wavFile.set(bytes, wavHeader.length);

		// Async Upload & Update
		const r2Promise = async () => {
			if (env.TTS_BUCKET) {
				await env.TTS_BUCKET.put(key, wavFile, {
					httpMetadata: { contentType: 'audio/wav' },
				});
				const storedUrl = `r2://${key}`;

				await updateTtsLogStatus(env.words_db, textHash, {
					url: storedUrl,
					status: 'completed',
					inputTokens: costResult.input.total,
					outputTokens: costResult.output.total,
					costMicros: costResult.cost,
				});

				// Also log usage logs
				await logUsage(
					env.logs_db,
					authReq.userId,
					modelNameShort,
					costResult.input.total,
					costResult.output.total,
					costResult.cost,
					'tts'
				).catch((e) => console.error('LogUsage Error', e));
			}
		};

		ctx.waitUntil(r2Promise());

		// Return Stream/Buffer directly
		// Status 200, Content-Type audio/wav
		return new Response(wavFile, {
			status: 200,
			headers: {
				'Content-Type': 'audio/wav',
			},
		});
	} catch (e: any) {
		console.error('TTS2 Error', e);
		await updateTtsLogStatus(env.words_db, textHash, {
			status: 'failed',
			inputTokens: 0,
			outputTokens: 0,
			costMicros: 0,
		});
		return new Response(`Error: ${e.message}`, { status: 500 });
	}
}
