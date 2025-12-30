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
