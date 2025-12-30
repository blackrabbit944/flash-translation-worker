export interface CostBreakdown {
	cost: number;
	input: {
		total: number;
		text: number;
		image: number;
		audio: number;
		prompt: number;
	};
	output: {
		total: number;
		image: number;
		text: number;
		audio: number;
		thought: number;
	};
}

import { LiveApiPrice } from './../config/pricing';

export const calculateCost = (modelName: string, usageMetadata: any, pricingMap: any): CostBreakdown => {
	const pricing = pricingMap[modelName];
	if (!pricing) {
		return {
			cost: 0,
			input: { total: 0, text: 0, image: 0, audio: 0, prompt: 0 },
			output: { total: 0, image: 0, text: 0, audio: 0, thought: 0 },
		};
	}

	// --- 1. Parse Input Tokens ---
	let inputTextInputTokens = 0;
	let inputAudioInputTokens = 0;
	let inputImageInputTokens = 0;

	if (usageMetadata.promptTokensDetails) {
		for (const detail of usageMetadata.promptTokensDetails) {
			if (detail.modality === 'TEXT') {
				inputTextInputTokens += detail.tokenCount;
			} else if (detail.modality === 'AUDIO') {
				inputAudioInputTokens += detail.tokenCount;
			} else if (detail.modality === 'IMAGE') {
				inputImageInputTokens += detail.tokenCount;
			}
		}
	} else {
		// Fallback: assume all prompt tokens are text if not detailed
		inputTextInputTokens = usageMetadata.promptTokenCount || 0;
	}

	const totalInputTokens = inputTextInputTokens + inputAudioInputTokens + inputImageInputTokens;

	// --- 2. Parse Output Tokens ---
	let outputTextTokens = 0; // Visible text
	let outputAudioTokens = 0;
	let outputImageTokens = 0;

	if (usageMetadata.candidatesTokensDetails || usageMetadata.responseTokensDetails) {
		const details = usageMetadata.candidatesTokensDetails || usageMetadata.responseTokensDetails;
		for (const detail of details) {
			if (detail.modality === 'TEXT') {
				outputTextTokens += detail.tokenCount;
			} else if (detail.modality === 'AUDIO') {
				outputAudioTokens += detail.tokenCount;
			} else if (detail.modality === 'IMAGE') {
				outputImageTokens += detail.tokenCount;
			}
		}
	} else {
		// Fallback: assume all candidate tokens are text
		outputTextTokens = usageMetadata.candidatesTokenCount || usageMetadata.responseTokenCount || 0;
	}

	const thoughtsTokens = usageMetadata.thoughtsTokenCount || 0;

	// Total output tokens for "count" purposes (might differ from pricing if thoughts are handled specially)
	const totalOutputTokens = outputTextTokens + outputAudioTokens + outputImageTokens + thoughtsTokens;

	// --- 3. Calculate Prices ---
	// Price lookup
	const textInputPrice = pricing.text_input ?? pricing.input ?? 0;
	const audioInputPrice = pricing.audio_input ?? pricing.input_audio ?? pricing.input ?? 0;
	// Image input price: user said "image price and text price are the same"
	const imageInputPrice = textInputPrice;

	const textOutputPrice = pricing.text_output ?? pricing.output ?? 0;
	const audioOutputPrice = pricing.audio_output ?? pricing.output_audio ?? pricing.output ?? 0;
	// Image output price: usually not a thing for text models, but if it exists, assume text price or 0
	const imageOutputPrice = textOutputPrice;
	// Thoughts price: usually same as text output
	const thoughtsPrice = textOutputPrice;

	// --- Fix for TTS models returning generic tokens without details ---
	// If the model is a TTS model (inferred by having audio_output price but no text or generic output price, or just prefer audio if text is 0)
	// And we have outputTextTokens but they came from 'candidatesTokenCount' (fallback) and not explicit TEXT modality...
	// We need to re-classify them as AUDIO.

	const usedFallbackForOutput =
		!usageMetadata.candidatesTokensDetails &&
		!usageMetadata.responseTokensDetails &&
		(usageMetadata.candidatesTokenCount > 0 || usageMetadata.responseTokenCount > 0);
	if (usedFallbackForOutput && outputTextTokens > 0 && textOutputPrice === 0 && audioOutputPrice > 0) {
		outputAudioTokens = outputTextTokens;
		outputTextTokens = 0;
	}

	// --- 4. Calculate Input Cost ---
	const inputCost =
		inputTextInputTokens * textInputPrice + inputAudioInputTokens * audioInputPrice + inputImageInputTokens * imageInputPrice;

	// --- 5. Calculate Output Cost ---
	const outputCost =
		outputTextTokens * textOutputPrice +
		outputAudioTokens * audioOutputPrice +
		outputImageTokens * imageOutputPrice +
		thoughtsTokens * thoughtsPrice;

	const totalCost = Math.ceil(inputCost + outputCost);

	const result: CostBreakdown = {
		cost: totalCost,
		input: {
			total: totalInputTokens,
			text: inputTextInputTokens,
			image: inputImageInputTokens,
			audio: inputAudioInputTokens,
			prompt: totalInputTokens,
		},
		output: {
			total: totalOutputTokens,
			image: outputImageTokens,
			text: outputTextTokens,
			audio: outputAudioTokens,
			thought: thoughtsTokens,
		},
	};

	console.log(`[Cost] Model: ${modelName} | Cost: ${result.cost} | Details:`, JSON.stringify(result, null, 2));

	return result;
};

export const aggregateUsage = (events: any[]): CostBreakdown => {
	let inputTextInputTokens = 0;
	let inputAudioInputTokens = 0;
	let inputImageInputTokens = 0;
	let inputPromptTokens = 0;

	let outputTextTokens = 0;
	let outputAudioTokens = 0;
	let outputImageTokens = 0;
	let outputThoughtTokens = 0;

	for (const evt of events) {
		// Input
		inputPromptTokens += evt.promptTokenCount || 0;

		if (evt.promptTokensDetails) {
			for (const detail of evt.promptTokensDetails) {
				if (detail.modality === 'TEXT') inputTextInputTokens += detail.tokenCount;
				else if (detail.modality === 'AUDIO') inputAudioInputTokens += detail.tokenCount;
				else if (detail.modality === 'IMAGE') inputImageInputTokens += detail.tokenCount;
			}
		} else {
			inputTextInputTokens += evt.promptTokenCount || 0;
		}

		// Output
		const details = evt.candidatesTokensDetails || evt.responseTokensDetails;
		if (details) {
			for (const detail of details) {
				if (detail.modality === 'TEXT') outputTextTokens += detail.tokenCount;
				else if (detail.modality === 'AUDIO') outputAudioTokens += detail.tokenCount;
				else if (detail.modality === 'IMAGE') outputImageTokens += detail.tokenCount;
			}
		} else {
			outputTextTokens += evt.candidatesTokenCount || evt.responseTokenCount || 0;
		}

		outputThoughtTokens += evt.thoughtsTokenCount || 0;
	}

	const outputTotalCombined = outputTextTokens + outputAudioTokens + outputImageTokens + outputThoughtTokens;

	return {
		cost: 0,
		input: {
			total: inputPromptTokens,
			text: inputTextInputTokens,
			image: inputImageInputTokens,
			audio: inputAudioInputTokens,
			prompt: inputPromptTokens,
		},
		output: {
			total: outputTotalCombined,
			image: outputImageTokens,
			text: outputTextTokens,
			audio: outputAudioTokens,
			thought: outputThoughtTokens,
		},
	};
};

export const calculateCostFromBreakdown = (
	modelName: string,
	breakdown: CostBreakdown,
	pricingMap: Record<string, LiveApiPrice>
): number => {
	const pricing = pricingMap[modelName];
	if (!pricing) {
		return 0;
	}

	const text_input_tokens = breakdown.input.text;
	const audio_input_tokens = breakdown.input.audio;
	const prompt_input_tokens = breakdown.input.prompt ?? 0;

	const text_output_tokens = breakdown.output.text;
	const audio_output_tokens = breakdown.output.audio;
	const thought_tokens = breakdown.output.thought;

	// Copying logic from calculateCost for consistency
	const textInputPrice = pricing.text_input ?? 0;
	const audioInputPrice = pricing.audio_input ?? 0;
	const textOutputPrice = pricing.text_output ?? 0;
	const audioOutputPrice = pricing.audio_output ?? 0;

	const inputCost = (text_input_tokens + prompt_input_tokens) * textInputPrice + audio_input_tokens * audioInputPrice;
	const outputCost = (text_output_tokens + thought_tokens) * textOutputPrice + audio_output_tokens * audioOutputPrice;

	return Math.ceil(inputCost + outputCost);
};
