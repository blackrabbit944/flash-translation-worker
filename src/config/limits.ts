export type ResourceType = 'text_translation' | 'image_translation' | 'live_translation' | 'tts' | 'recognition';
export type MembershipTier = 'FREE' | 'PRO' | 'UNLIMITED';

export interface Quota {
	daily: number;
	monthly: number;
	total?: number;
}

export const TIER_LIMITS: Record<MembershipTier, Record<ResourceType, Quota>> = {
	// FREE: {
	// 	text_translation: { daily: 3, monthly: 10, total: 10 },
	// 	image_translation: { daily: 1, monthly: 3, total: 3 },
	// 	live_translation: { daily: 300, monthly: 300, total: 300 },
	// 	tts: { daily: 10, monthly: 10, total: 10 },
	// 	recognition: { daily: 10, monthly: 10, total: 10 },
	// },
	FREE: {
		text_translation: { daily: 300, monthly: 1000, total: 1000 },
		image_translation: { daily: 100, monthly: 300, total: 300 },
		live_translation: { daily: 300, monthly: 300, total: 300 },
		tts: { daily: 300, monthly: 1000, total: 1000 },
		recognition: { daily: 300, monthly: 1000, total: 1000 },
	},
	PRO: {
		text_translation: { daily: 100, monthly: 3000 },
		image_translation: { daily: 100, monthly: 3000 },
		live_translation: { daily: 7200, monthly: 108000 },
		tts: { daily: 100, monthly: 3000 },
		recognition: { daily: 100, monthly: 3000 },
	},
	UNLIMITED: {
		text_translation: { daily: 1000, monthly: 30000 },
		image_translation: { daily: 1000, monthly: 30000 },
		live_translation: { daily: 43200, monthly: 648000 },
		tts: { daily: 100, monthly: 3000 },
		recognition: { daily: 100, monthly: 3000 },
	},
};

export const ENDPOINT_TYPE_MAP: Record<string, ResourceType> = {
	'/translation/text': 'text_translation',
	'/translation/image': 'image_translation',
	'/translation/live': 'live_translation',
	'/translation/tts': 'tts',
	'/translation/recognition': 'recognition',
};

export function getResourceTypeFromUrl(pathname: string): ResourceType {
	for (const [path, type] of Object.entries(ENDPOINT_TYPE_MAP)) {
		if (pathname.includes(path)) {
			return type;
		}
	}
	// Default to text if unknown, or maybe throw error?
	// For now default to text to match previous behavior
	return 'text_translation';
}
