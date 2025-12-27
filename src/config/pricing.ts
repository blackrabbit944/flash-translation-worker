export const PRICING_PER_1M: Record<string, { input: number; output: number }> = {
	'gemini-3-flash-preview': {
		input: 0.5,
		output: 3,
	},
	'gemini-1.5-flash': {
		input: 0.075,
		output: 0.3,
	},
};

export const PRICING_PER_1M_LIVE: Record<string, { text_input: number; text_output: number; audio_input: number; audio_output: number }> = {
	'gemini-2.5-flash-native-audio-preview-12-2025': {
		text_input: 0.5, // Assumption
		text_output: 3, // Assumption
		audio_input: 3, // Assumption
		audio_output: 12, // Assumption
	},
};
