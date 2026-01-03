export interface CorrectionRequest {
	original: string;
	translated: string;
	sourceLang: string;
	targetLang: string;
}

export class OpenRouterService {
	async correctInput(env: Env, request: CorrectionRequest): Promise<string> {
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

		const apiKey = env.OPENROUTER_API_KEY;
		if (!apiKey) {
			console.error('OPENROUTER_API_KEY is missing in env');
			throw new Error('OPENROUTER_API_KEY is not defined');
		}

		// console.log('Using OpenRouter API Key:', apiKey.substring(0, 10) + '...');
		// console.log('OpenRouter Req Prompt:', prompt);

		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: 'qwen/qwen3-235b-a22b-2507', // Using a cost-effective model or as configured
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('OpenRouter API Error:', response.status, errorText);
			throw new Error(`OpenRouter API Error: ${response.status}`);
		}

		const data: any = await response.json();
		const correctedText = data.choices?.[0]?.message?.content?.trim();

		return correctedText || original; // Fallback to original if something goes wrong or empty
	}
}
