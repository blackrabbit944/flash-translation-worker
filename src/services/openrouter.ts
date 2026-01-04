export interface CorrectionRequest {
	original: string;
	translated: string;
	sourceLang: string;
	targetLang: string;
}

export class OpenRouterService {
	private async getMd5(text: string): Promise<string> {
		const msgUint8 = new TextEncoder().encode(text);
		const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	private async callOpenRouterAPI(
		env: Env,
		model: string,
		messages: any[],
		stream: boolean = true,
		extraBody: any = {}
	): Promise<Response> {
		const apiKey = env.OPENROUTER_API_KEY;
		if (!apiKey) {
			console.error('OPENROUTER_API_KEY is missing in env');
			throw new Error('OPENROUTER_API_KEY is not defined');
		}

		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				stream,
				...extraBody,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('OpenRouter API Error:', response.status, errorText);
			throw new Error(`OpenRouter API Error: ${response.status}`);
		}

		return response;
	}

	private async handleStreamResponse(
		response: Response,
		env: Env,
		userId: string,
		ctx: ExecutionContext,
		modelName: string,
		endpointName: string,
		contentHash: string
	): Promise<Response> {
		// Return streaming response in SSE format
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();

		// Track usage metadata
		let usageMetadata: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | null = null;

		// Process the stream in the background
		(async () => {
			try {
				const reader = response.body?.getReader();
				const decoder = new TextDecoder();

				if (reader) {
					let buffer = '';
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						const chunk = decoder.decode(value, { stream: true });
						buffer += chunk;
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const data = line.slice(6);
								if (data === '[DONE]') continue;

								try {
									const parsed = JSON.parse(data);

									// Capture usage metadata if present
									if (parsed.usage) {
										usageMetadata = parsed.usage;
									}

									const content = parsed.choices?.[0]?.delta?.content;
									if (content) {
										// Convert OpenRouter format to Gemini-like SSE format
										const geminiFormat = {
											candidates: [
												{
													content: { parts: [{ text: content }] },
												},
											],
										};
										await writer.write(encoder.encode(`data: ${JSON.stringify(geminiFormat)}\n\n`));
									}
								} catch (e) {
									// Ignore parse errors
								}
							}
						}
					}
				}

				// Log usage after stream completes
				if (usageMetadata && usageMetadata.prompt_tokens) {
					await this.logOpenRouterUsage(env, userId, ctx, modelName, endpointName, contentHash, usageMetadata);
				} else {
					console.log(`[OpenRouter ${endpointName}] No usage metadata received`);
				}
			} catch (error) {
				console.error('Stream processing error:', error);
			} finally {
				await writer.close();
			}
		})();

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}

	private async handleJSONResponse(
		response: Response,
		env: Env,
		userId: string,
		ctx: ExecutionContext,
		modelName: string,
		endpointName: string,
		contentHash: string
	): Promise<any> {
		const data: any = await response.json();

		if (data.usage) {
			await this.logOpenRouterUsage(env, userId, ctx, modelName, endpointName, contentHash, data.usage);
		} else {
			console.log(`[OpenRouter ${endpointName}] No usage metadata received`);
		}

		return data;
	}

	private async logOpenRouterUsage(
		env: Env,
		userId: string,
		ctx: ExecutionContext,
		modelName: string,
		endpointName: string,
		contentHash: string,
		usageMetadata: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
	) {
		const { logUsage } = await import('../models/usage');
		const { calculateCost } = await import('../utils/cost');
		const { PRICING_PER_1M } = await import('../config/pricing');

		// Convert OpenRouter usage format to Gemini-like format
		const geminiUsageMetadata = {
			promptTokenCount: usageMetadata.prompt_tokens || 0,
			candidatesTokenCount: usageMetadata.completion_tokens || 0,
			totalTokenCount: usageMetadata.total_tokens || 0,
		};

		console.log(`[OpenRouter ${endpointName}] Raw metadata:`, JSON.stringify(usageMetadata, null, 2));

		// Use centralized cost calculation
		const costResult = calculateCost(modelName, geminiUsageMetadata, PRICING_PER_1M);

		let finalCostMicros = costResult.cost;

		// Use Native OpenRouter Cost if available (convert dollars to micros)
		if (usageMetadata.cost !== undefined && typeof usageMetadata.cost === 'number') {
			// cost is in USD (e.g. 0.0005)
			// micros = USD * 1_000_000
			finalCostMicros = Math.round(usageMetadata.cost * 1_000_000);
			console.log(`[OpenRouter ${endpointName}] Using native cost: $${usageMetadata.cost} -> ${finalCostMicros} micros`);
		}

		console.log(`[OpenRouter ${endpointName}] Calculated:`, {
			model: modelName,
			inputTokens: costResult.input.total,
			outputTokens: costResult.output.total,
			costMicros: finalCostMicros,
			endpoint: endpointName,
			contentHash,
			nativeCost: usageMetadata.cost,
		});

		ctx.waitUntil(
			logUsage(env.logs_db, userId, modelName, costResult.input.total, costResult.output.total, finalCostMicros, endpointName, contentHash)
		);
	}

	async correctInput(env: Env, request: CorrectionRequest, userId: string, ctx: ExecutionContext): Promise<string> {
		const { original, translated, sourceLang, targetLang } = request;

		const prompt = `
        You are a translation correction assistant.
        The conversation involves two languages: ${sourceLang} and ${targetLang}.
        
        The user's speech was translated into:
        "${translated}"
        
        Since this is the translation result, the original input MUST be in the other language (whichever of the two is NOT the language of the translation).
        
        The initial speech recognition (ASR) result was:
        "${original}"
        
        The ASR result might have incorrect language detection or content errors. 
        Your task is to ignore the flaws in the ASR and reconstruct the TRUE original speech text.
        
        Logic:
        1. Identify the language of the translation ("${translated}").
        2. The user's input language is the opposite one.
        3. Reconstruct what the user said in that input language to produce this translation.
        
        Output ONLY the corrected original text. Do not provide explanations.
        `;

		const modelName = 'qwen/qwen3-235b-a22b-2507';
		const response = await this.callOpenRouterAPI(
			env,
			modelName,
			[{ role: 'user', content: prompt }],
			false // Non-streaming
		);

		const contentHash = await this.getMd5(original);
		const data = await this.handleJSONResponse(response, env, userId, ctx, modelName, 'input_correction', contentHash);

		const correctedText = data.choices?.[0]?.message?.content?.trim();
		return correctedText || original;
	}

	async translateWord(
		env: Env,
		userId: string,
		text: string,
		sourceLang: string,
		targetLang: string,
		sourceLangName: string,
		targetLangName: string,
		ctx: ExecutionContext
	): Promise<Response> {
		const prompt = `You are a smart translator. Analyze the following text and translate it from ${targetLangName} to ${sourceLangName}.
        
        Input is verified to be a **Word** or **Phrase**.
        
        Output **ONLY** a valid JSON object with the following structure:
        
        {
            "type": "word",
            "origin": "${sourceLangName}语言的${text}",
            "translation": "${targetLang}语言的${text}",
            "kana": "Pronunciation (if applicable, e.g. Japanese Kana, Pinyin, otherwise null)",
            "examples": [
                {
                    "original": "Example sentence 1 in ${targetLang}",
                    "translation": "Example sentence 1 in ${sourceLang}",
                    "kana": "Pronunciation of example 1 (if applicable)"
                }
            ],
            "memory_tip": "A fun or useful tip to remember this word",
            "explanation": "Brief explanation of meaning and usage",
            "english_word": "English translation"
        }
        
        你所有的回答要用 "${sourceLang}" 语言回答,因为你面对的用户的母语是: ${sourceLang}。
        examples要给出2个例句.

        我们返回的translation都要使用${targetLang}语言。而origin都是${sourceLang}语言。

        Input Text:
        "${text}"`;

		const modelName = 'qwen/qwen3-235b-a22b-2507';
		const response = await this.callOpenRouterAPI(
			env,
			modelName,
			[{ role: 'user', content: prompt }],
			true // Enable streaming
		);

		// Calculate text hash for logging
		const textHash = await this.getMd5(text);

		return this.handleStreamResponse(response, env, userId, ctx, modelName, 'word_translation', textHash);
	}

	async translateLongText(
		env: Env,
		userId: string,
		text: string,
		sourceLang: string,
		targetLang: string,
		sourceLangName: string,
		targetLangName: string,
		ctx: ExecutionContext
	): Promise<Response> {
		const prompt = `
       你是一个专业的翻译员. 用户的母语是 ${sourceLangName} ,他经常需要翻译的语言是 ${targetLangName}.
              
       要求:
       - 理解用户的输入并帮助用户翻译.
       - 如果内容特别长,就直接翻译并输出给用户
       - 如果句子只是一两句,我还希望你给用户讲解对应的语法,用用户的母语讲解
       - 输出可以用markdown文本,来展示更多你想讲的数据
       - 你要移除\"您好,作为一个专业的翻译人员, 我很乐意帮你提供...这些开头的词语\",直接开始讲解你的翻译\"
        
       用户的输入是:
       "${text}"
       `;

		const modelName = 'qwen/qwen3-235b-a22b-2507';
		const response = await this.callOpenRouterAPI(
			env,
			modelName,
			[{ role: 'user', content: prompt }],
			true // Enable streaming
		);

		// Calculate text hash for logging
		const textHash = await this.getMd5(text);

		return this.handleStreamResponse(response, env, userId, ctx, modelName, 'long_text_translation', textHash);
	}

	async classifyText(
		env: Env,
		userId: string,
		text: string,
		ctx: ExecutionContext
	): Promise<{ type: 'word' | 'sentence' | 'multiple_sentences' }> {
		const prompt = `Classify the following text into one of these types:
           - "word" (Single word or short phrase)
           - "sentence" (Complete sentence)
           - "multiple_sentences" (Paragraph or multiple sentences)

           Return ONLY a JSON object with a "type" field containing one of the exact strings above. Nothing else.

           Input: "${text}"`;

		const modelName = 'qwen/qwen3-235b-a22b-2507';
		const response = await this.callOpenRouterAPI(env, modelName, [{ role: 'user', content: prompt }], false, {
			response_format: { type: 'json_object' },
		});

		// Calculate text hash for logging
		const textHash = await this.getMd5(text);

		const data = await this.handleJSONResponse(response, env, userId, ctx, modelName, 'text_classification', textHash);
		const resultText = data.choices?.[0]?.message?.content?.trim();

		if (!resultText) {
			console.error('No classification result from OpenRouter');
			return { type: 'sentence' }; // Default fallback
		}

		// Parse classification result
		let classificationType: 'word' | 'sentence' | 'multiple_sentences';
		try {
			const parsed = JSON.parse(resultText);
			const type = parsed.type?.toLowerCase();

			if (type && type.includes('multiple_sentences')) {
				classificationType = 'multiple_sentences';
			} else if (type && type.includes('word')) {
				classificationType = 'word';
			} else {
				classificationType = 'sentence';
			}
		} catch (e) {
			console.error('Failed to parse classification result:', resultText);
			classificationType = 'sentence'; // Default fallback
		}

		return { type: classificationType };
	}

	async translateImage(
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

		const modelName = 'qwen/qwen3-vl-235b-a22b-instruct';
		const response = await this.callOpenRouterAPI(
			env,
			modelName,
			[
				{
					role: 'user',
					content: [
						{
							type: 'text',
							text: finalPrompt,
						},
						{
							type: 'image',
							source: {
								type: 'base64',
								media_type: mimeType,
								data: pureBase64,
							},
						},
					],
				},
			],
			true
		);

		// Calculate image hash for logging
		const imageHash = await this.getMd5(pureBase64);

		return this.handleStreamResponse(response, env, userId, ctx, modelName, 'image_translation', imageHash);
	}
}
