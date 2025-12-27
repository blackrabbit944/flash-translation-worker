import { createDb } from '../db';
import { translations } from '../db/schema';
import { logUsage } from '../models/usage';
// @ts-ignore
import { eq, and } from 'drizzle-orm';

import { PRICING_PER_1M } from '../config/pricing';

const GATEWAY_CONFIG = {
	ACCOUNT_ID: 'd3c42400d063e65d9a797c7d4dba04e4',
	GATEWAY_ID: 'flash-translation',
};

function getGatewayUrl(modelName: string, apiKey: string): string {
	// 1. 确保基础路径正确
	const baseUrl = `https://gateway.ai.cloudflare.com/v1/${GATEWAY_CONFIG.ACCOUNT_ID}/${GATEWAY_CONFIG.GATEWAY_ID}/google-ai-studio/v1beta`;

	// 2. 拼接具体的模型和动作
	// 注意：:streamGenerateContent 必须紧跟模型名称
	return `${baseUrl}/models/${modelName}:streamGenerateContent?key=${apiKey}&alt=sse`;
}

async function getMd5(text: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class GeminiService {
	async translateAndStream(
		env: Env,
		userId: string,
		text: string,
		sourceLang: string,
		targetLang: string,
		sourceLangName: string,
		targetLangName: string,
		ctx: ExecutionContext
	): Promise<Response> {
		const textHash = await getMd5(text);

		// 1. Check Cache
		const db = createDb(env.words_db);
		const cached = await db
			.select()
			.from(translations)
			.where(
				and(eq(translations.sourceTextHash, textHash), eq(translations.sourceLang, sourceLang), eq(translations.targetLang, targetLang))
			)
			.get();

		if (cached) {
			console.log('Cache hit for:', text);
			// Return cached result as SSE to mimic Gemini stream for client compatibility
			const mimicResponse = {
				candidates: [
					{
						content: { parts: [{ text: cached.resultJson }] },
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

		// 2. Prepare Gemini Request
		const apiKey = env.GEMINI_API_KEY;
		const modelName = 'gemini-3-flash-preview';

		// Use Cloudflare AI Gateway
		const urlString = getGatewayUrl(modelName, apiKey);

		const prompt = `You are a smart translator. Analyze the following text and translate it from ${sourceLangName} to ${targetLangName}.
        
        Determine if the input is:
        1. "word": A single word or short phrase.
        2. "sentence": A single complete sentence.
        3. "multiple_sentences": Multiple sentences or a paragraph.
        
        Output **ONLY** a valid JSON object with the following structure based on the type:
        
        Case 1: Word/Phrase
        {
            "type": "word",
            "translation": "Translated word",
            "kana": "Pronunciation (if applicable, e.g. Japanese Kana, Pinyin, otherwise null)",
            "examples": [
                {
                    "original": "Example sentence 1 in ${targetLangName}",
                    "translation": "Example sentence 1 in ${sourceLangName}",
                    "kana": "Pronunciation of example 1 (if applicable)"
                },
                {
                    "original": "Example sentence 2 in ${targetLangName}",
                    "translation": "Example sentence 2 in ${sourceLangName}",
                    "kana": "Pronunciation of example 2 (if applicable)"
                }
            ],
            "memory_tip": "A fun or useful tip to remember this word",
            "explanation": "Brief explanation of meaning and usage",
            "english_word": "Apple"
        }
        
        Case 2: Single Sentence
        {
            "type": "sentence",
            "translation": "Translated sentence",
            "explanation": "Brief explanation of the sentence meaning",
            "grammar_analysis": "Explanation of key grammar points used in this sentence"
        }
        
        Case 3: Multiple Sentences
        {
            "type": "multiple_sentences",
            "translation": "Full translation"
        }

        你所有的回答要用 "${sourceLangName}" 语言回答,因为你面对的用户的母语是: ${sourceLangName}。
        
        Input Text:
        "${text}"`;

		const body = {
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				response_mime_type: 'application/json',
			},
		};

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (env.CLOUDFLARE_GATEWAY_TOKEN) {
			headers['cf-aig-authorization'] = `Bearer ${env.CLOUDFLARE_GATEWAY_TOKEN}`;
		}

		const response = await fetch(urlString, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error('Gemini API Error:', response.status, errText);
			throw new Error(`Gemini API Error: ${response.status}`);
		}

		// 3. Handle Stream & Logging via Helper
		return this.handleStreamResponse(
			response,
			env,
			ctx,
			userId,
			modelName,
			'text_translation',
			undefined, // no hash for text logs
			async (fullText) => {
				// Cache Callback
				if (fullText) {
					await db
						.insert(translations)
						.values({
							id: crypto.randomUUID(),
							sourceTextHash: textHash,
							sourceText: text,
							sourceLang: sourceLang,
							targetLang: targetLang,
							resultJson: fullText,
							createdAt: Date.now(),
						})
						.execute()
						.catch((e) => console.error('Cache save error', e));
				}
			}
		);
	}

	async translateImageAndStream(
		env: Env,
		userId: string,
		imageBase64: string,
		mimeType: string,
		promptUser: string,
		sourceLang: string,
		targetLang: string,
		sourceLangName: string,
		targetLangName: string,
		ctx: ExecutionContext
	): Promise<Response> {
		// 1. Prepare Gemini Request
		const apiKey = env.GEMINI_API_KEY;
		const modelName = 'gemini-3-flash-preview';

		// Use Cloudflare AI Gateway
		const urlString = getGatewayUrl(modelName, apiKey);

		// Clean Base64 format (remove data:image/xxx;base64, prefix and newlines)
		const pureBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

		// Construct Prompt based on User's request
		let finalPrompt = `Analyze the image and extract the text.
Then, translate the extracted text from ${sourceLangName} to ${targetLangName}.

Output the result in **Markdown** format.
- You can output what the original text is, and what the translation is, to make it easier for the user to understand and compare.
- Do NOT include any JSON.
- **Do NOT use code blocks (\`\`\`) for normal text.** content should be standard text.
- Just output the translated text directly.

The user's mother tongue is ${targetLangName}. Therefore, your output should be in ${targetLangName}, except for the original text part which should be in ${sourceLangName}.`;

		if (promptUser && promptUser.trim() !== '') {
			finalPrompt += `\n\nUser Requirement: ${promptUser}`;
		}

		const body = {
			contents: [
				{
					parts: [
						{ text: finalPrompt },
						{
							inline_data: {
								mime_type: mimeType,
								data: pureBase64,
							},
						},
					],
				},
			],
			generationConfig: {
				response_mime_type: 'text/plain',
			},
		};

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (env.CLOUDFLARE_GATEWAY_TOKEN) {
			headers['cf-aig-authorization'] = `Bearer ${env.CLOUDFLARE_GATEWAY_TOKEN}`;
		}

		const response = await fetch(urlString, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error('Gemini Image API Error:', response.status, errText);
			throw new Error(`Gemini Image API Error: ${response.status}`);
		}

		// Calculate hash BEFORE helper
		const imageHash = await getMd5(pureBase64);

		// 2. Handle Stream & Logging via Helper
		return this.handleStreamResponse(
			response,
			env,
			ctx,
			userId,
			modelName,
			'image_translation',
			imageHash
			// No onComplete callback for Image (no caching)
		);
	}

	private async handleStreamResponse(
		response: Response,
		env: Env,
		ctx: ExecutionContext,
		userId: string,
		modelName: string,
		endpoint: string = 'text_translation',
		requestHash?: string,
		onComplete?: (fullText: string) => Promise<void>
	): Promise<Response> {
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = response.body?.getReader();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		let usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 0 };
		let fullText = '';

		const processPromise = (async () => {
			try {
				if (!reader) return;

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value, { stream: true });
					// Pass chunk to client immediately
					await writer.write(encoder.encode(chunk));

					// Log usage metadata if present
					const lines = chunk.split('\n');
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const jsonStr = line.slice(6);
							try {
								const data = JSON.parse(jsonStr);
								if (data.usageMetadata) {
									usageMetadata = data.usageMetadata;
								}
								if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
									fullText += data.candidates[0].content.parts[0].text;
								}
							} catch (e) {
								// ignore
							}
						}
					}
				}
			} catch (err) {
				console.error('Stream processing error:', err);
			} finally {
				await writer.close();
				// Save to DB (Fire and Forget)
				if (usageMetadata.promptTokenCount > 0) {
					const prices = PRICING_PER_1M['gemini-3-flash-preview'];
					const inputTokens = usageMetadata.promptTokenCount;
					const outputTokens = usageMetadata.candidatesTokenCount;
					const cost = Math.ceil(inputTokens * prices.input + outputTokens * prices.output);

					await logUsage(env.logs_db, userId, modelName, inputTokens, outputTokens, cost, endpoint, requestHash);
				}

				if (onComplete) {
					await onComplete(fullText);
				}
			}
		})();

		ctx.waitUntil(processPromise);

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}
}
