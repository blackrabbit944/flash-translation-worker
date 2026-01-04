export const PRICING_PER_1M: Record<string, { input: number; output?: number; input_audio?: number; output_audio?: number }> = {
	'gemini-3-flash-preview': {
		input: 0.5,
		input_audio: 1,
		output: 3,
	},
	'gemini-2.5-flash': {
		input: 0.3,
		input_audio: 1,
		output: 2.5,
	},
	'gemini-2.5-flash-preview-tts': {
		input: 0.5,
		output_audio: 10,
	},
	// OpenRouter QWEN models
	'qwen/qwen3-235b-a22b-2507': {
		input: 0.071, // $0.071 per 1M input tokens
		output: 0.463, // $0.463 per 1M output tokens
	},
	'qwen/qwen3-vl-235b-a22b-instruct': {
		input: 0.2, // $0.20 per 1M input tokens
		output: 1.2, // $1.20 per 1M output tokens
	},
};

export interface LiveApiPrice {
	text_input: number;
	text_output: number;
	audio_input: number;
	audio_output: number;
}

export const PRICING_PER_1M_LIVE: Record<string, LiveApiPrice> = {
	'gemini-2.5-flash-native-audio-preview-12-2025': {
		text_input: 0.5, // Assumption
		audio_input: 3, // Assumption
		text_output: 2, // Assumption
		audio_output: 12, // Assumption
	},
};
