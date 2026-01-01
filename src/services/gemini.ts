import { createDb } from '../db';
import { translations } from '../db/schema';
import { logUsage } from '../models/usage';
// @ts-ignore
import { eq, and } from 'drizzle-orm';

import { PRICING_PER_1M } from '../config/pricing';
import { calculateCost } from '../utils/cost';
import { env } from 'cloudflare:workers';

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
	async findInCache(env: Env, text: string, sourceLang: string, targetLang: string): Promise<string | null> {
		const textHash = await getMd5(text);
		const db = createDb(env.words_db);
		const cached = await db
			.select()
			.from(translations)
			.where(
				and(eq(translations.sourceTextHash, textHash), eq(translations.sourceLang, sourceLang), eq(translations.targetLang, targetLang))
			)
			.get();
		return cached ? cached.resultJson : null;
	}

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
		const cachedResult = await this.findInCache(env, text, sourceLang, targetLang);

		if (cachedResult) {
			console.log('Cache hit for:', text);
			// Return cached result as SSE to mimic Gemini stream for client compatibility
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
        }
        
        Case 3: Multiple Sentences
        {
            "type": "multiple_sentences",
        }
        
        Do not output any other fields for Case 2 and Case 3, just the type and an empty translation string.

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
					// Re-create DB connection here since we are inside a callback
					const db = createDb(env.words_db);
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

	async translateLongTextAndStream(
		env: Env,
		userId: string,
		text: string,
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

		const prompt = `
       你是一个专业的翻译员. 用户的母语是 ${sourceLangName} ,他经常需要翻译的语言是 ${targetLangName}.
              
       要求:
       - 理解用户的输入并帮助用户翻译.
       - 如果内容特别长,就直接翻译并输出给用户
       - 如果句子只是一两句,我还希望你给用户讲解对应的语法,用用户的母语讲解
       - 输出可以用markdown文本,来展示更多你想讲的数据
       - 你要移除“您好,作为一个专业的翻译人员, 我很乐意帮你提供...这些开头的词语“,直接开始讲解你的翻译”
        
       用户的输入是:
       "${text}"
       `;

		const body = {
			contents: [{ parts: [{ text: prompt }] }],
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
			console.error('Gemini LongText API Error:', response.status, errText);
			throw new Error(`Gemini API Error: ${response.status}`);
		}

		// 2. Handle Stream & Logging via Helper
		// We use 'text_translation' as endpoint to share quota with normal text translation
		return this.handleStreamResponse(response, env, ctx, userId, modelName, 'text_translation', undefined);
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
            Then.

            请你考虑语言背景，进行翻译。用户的母语是 ${sourceLangName} ,目前用户希望翻译的语言是 ${targetLangName}

            Output the result in **Markdown** format.
            - You can output what the original text is, and what the translation is, to make it easier for the user to understand and compare.
            - Do NOT include any JSON.
            - **Do NOT use code blocks (\`\`\`) for normal text.** content should be standard text.
            - Just output the translated text directly.

            所以请你用的所有的解释性的文字都要用用户的母语来说.
        `;

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

		let usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 };
		let fullText = '';
		let buffer = '';

		const processPromise = (async () => {
			try {
				if (!reader) return;

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value, { stream: true });
					// Pass chunk to client immediately
					await writer.write(encoder.encode(chunk));

					// Append chunk to buffer and parse lines
					buffer += chunk;
					const lines = buffer.split('\n');
					// The last line might be incomplete, keep it in buffer
					buffer = lines.pop() || '';

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

				// Process any remaining buffer (though usually SSE ends with newline)
				if (buffer.startsWith('data: ')) {
					try {
						const jsonStr = buffer.slice(6);
						const data = JSON.parse(jsonStr);
						if (data.usageMetadata) {
							usageMetadata = data.usageMetadata;
						}
						if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
							fullText += data.candidates[0].content.parts[0].text;
						}
					} catch (e) {}
				}
			} catch (err) {
				console.error('Stream processing error:', err);
			} finally {
				await writer.close();
				// Save to DB (Fire and Forget)
				// Save to DB (Fire and Forget)
				if (usageMetadata.promptTokenCount > 0) {
					console.log('translate usageMetadata', usageMetadata);
					const result = calculateCost(modelName, usageMetadata, PRICING_PER_1M);
					const inputTokens = result.input.total;
					const outputTokens = result.output.total;

					await logUsage(env.logs_db, userId, modelName, inputTokens, outputTokens, result.cost, endpoint, requestHash);
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
	async recognizeIntent(
		env: Env,
		userId: string,
		audioBase64: string,
		sourceLang: string,
		targetLang: string,
		sourceLangName: string,
		targetLangName: string
	): Promise<string | null> {
		const apiKey = env.GEMINI_API_KEY;
		const modelName = 'gemini-2.5-flash';

		const urlString = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

		const prompt = `
            Process the audio file and extract the user's intent content.
            
            Current Context:
            - User's native language is likely: ${sourceLangName}
            - User's wanna to translate language is: ${targetLangName}
            
            Scenario: The user is using a Translation App. They will speak a sentence that they want to TRANSLATE.
            
            Your job is to extract the **exact text** the user wants to translate.
            
            Examples:
            User audio: "How do you say 'Hello' in Japanese?"
            Output: "Hello"
            
            User audio: "Translate 'Where is the bathroom' to Chinese."
            Output: "Where is the bathroom"
            
            User audio: "Apple"
            Output: "Apple"
            
            User audio: "你好" (Just the content)
            Output: "你好"
            
            User audio: "Please translate this sentence: It is a beautiful day today."
            Output: "It is a beautiful day today."
            
            **Critical Instruction:**
            - Ignore all translation-related command phrases, questions, or polite wrappers in ANY language (e.g., "Translate...", "How do you say...", "...怎么说", "...totte nani?", "...번역해줘").
            - Ignore language-related phrasing. For example, if the input is 'How do you say Hello in Japanese', we strictly want 'Hello'."
            - Handle both prefix commands (e.g., "Translate apple") and suffix commands (e.g., "Apple in Japanese please").
            - Extract ONLY the core content the user intends to translate.
            - Provide the output as a simple JSON object: { "content": "THE_EXTRACTED_TEXT" }
            - Do NOT return markdown code blocks.
            `;

		const body = {
			contents: [
				{
					parts: [
						{
							inline_data: {
								mime_type: 'audio/wav',
								data: audioBase64,
							},
						},
						{ text: prompt },
					],
				},
			],
			generationConfig: {
				response_mime_type: 'application/json',
			},
		};

		const response = await fetch(urlString, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error('Gemini Intent Recognition Error:', response.status, errText);
			return null;
		}

		const json: any = await response.json();

		// Log Usage
		if (json.usageMetadata) {
			console.log('Gemini Intent Recognition Usage Metadata:', json.usageMetadata);

			const result = calculateCost(modelName, json.usageMetadata, PRICING_PER_1M);

			// Log to DB (Fire and Forget)
			// Using logic similar to other methods
			logUsage(env.logs_db, userId, modelName, result.input.total, result.output.total, result.cost, 'intent_recognition').catch((err) =>
				console.error('Failed to log usage', err)
			);
		}

		// Parse Response
		try {
			const candidate = json.candidates?.[0];
			const contentParts = candidate?.content?.parts;
			const textPart = contentParts?.[0]?.text;

			if (textPart) {
				const resultObj = JSON.parse(textPart);
				if (resultObj.content) {
					console.log(`[Intent] Recognized: ${resultObj.content}`);
					return resultObj.content;
				}
			}
		} catch (e) {
			console.error('[Intent] Failed to parse response json', e);
		}
		return null;
	}
}
