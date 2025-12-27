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
	// Basic lookup, might need to handle BCP-47 tags like zh-CN -> Chinese
	// For now, just lower case and lookup base.
	// Ideally use Intl.DisplayNames but keeping simple for now or using existing map.
	return LANGUAGE_NAMES[code.toLowerCase()] || code;
}

export function normalizeLanguageTag(lang: string): string {
	if (!lang) return lang;
	const normalized = lang.replace('_', '-').toLowerCase();

	// Mapping table: short codes to region specifics
	const map: Record<string, string> = {
		// 基础核心语种
		zh: 'zh-CN', // 中文（简体）
		en: 'en-US', // 英语（美式）
		ja: 'ja-JP', // 日语
		ko: 'ko-KR', // 韩语

		// 欧洲主要语种（您要求的补充）
		de: 'de-DE', // 德语
		fr: 'fr-FR', // 法语
		es: 'es-ES', // 西班牙语
		pt: 'pt-PT', // 葡萄牙语（注：若侧重巴西市场可设为 pt-BR）
		it: 'it-IT', // 意大利语
		ru: 'ru-RU', // 俄语

		// 东南亚与南亚
		vi: 'vi-VN', // 越南语
		th: 'th-TH', // 泰语
		id: 'id-ID', // 印尼语
		hi: 'hi-IN', // 印地语
		ms: 'ms-MY', // 马来语

		// 其他常用
		ar: 'ar-SA', // 阿拉伯语
		tr: 'tr-TR', // 土耳其语
		nl: 'nl-NL', // 荷兰语
	};

	const mapped = map[normalized] || normalized;

	try {
		// Canonicalize using Intl.Locale (e.g. zh-cn -> zh-CN)
		return new Intl.Locale(mapped).toString();
	} catch (e) {
		// If invalid, return mapped (let validation catch it downstream)
		return mapped;
	}
}
