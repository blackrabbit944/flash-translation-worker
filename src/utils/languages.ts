export const LANGUAGE_NAMES: Record<string, string> = {
	en: 'English',
	zh: 'Chinese',
	ja: 'Japanese',
	es: 'Spanish',
	fr: 'French',
	de: 'German',
	it: 'Italian',
	ko: 'Korean',
	pt: 'Portuguese',
	ru: 'Russian',
	vi: 'Vietnamese',
	th: 'Thai',
	id: 'Indonesian',
	hi: 'Hindi',
	// Add more as needed, or fallback to the code itself if not found
};

export function getLanguageName(code: string): string {
	return LANGUAGE_NAMES[code.toLowerCase()] || code;
}
