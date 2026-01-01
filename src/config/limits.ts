export type ResourceType = 'text_translation' | 'text_classify' | 'image_translation' | 'live_translation' | 'tts' | 'recognition';
export type MembershipTier = 'FREE' | 'PRO' | 'UNLIMITED' | 'TRIAL_CANCELLED';

export interface Quota {
	daily: number;
	monthly: number;
	total?: number;
}

export const TIER_LIMITS: Record<MembershipTier, Record<ResourceType, Quota>> = {
	FREE: {
		text_translation: { daily: 40, monthly: 100, total: 100 },
		text_classify: { daily: 40, monthly: 100, total: 100 },
		image_translation: { daily: 20, monthly: 20, total: 20 },
		live_translation: { daily: 600, monthly: 600, total: 600 },
		tts: { daily: 200, monthly: 1000, total: 1000 },
		recognition: { daily: 600, monthly: 600, total: 600 },
	},
	PRO: {
		text_translation: { daily: 100, monthly: 500 },
		text_classify: { daily: 100, monthly: 500 },
		image_translation: { daily: 100, monthly: 300 },
		live_translation: { daily: 7200, monthly: 108000 },
		tts: { daily: 500, monthly: 3000 },
		recognition: { daily: 100, monthly: 1000 },
	},
	UNLIMITED: {
		text_translation: { daily: 500, monthly: 2000 },
		text_classify: { daily: 500, monthly: 2000 },
		image_translation: { daily: 150, monthly: 1200 },
		live_translation: { daily: 72000, monthly: 324000 },
		tts: { daily: 1000, monthly: 6000 },
		recognition: { daily: 100, monthly: 2000 },
	},
	TRIAL_CANCELLED: {
		text_translation: { daily: 40, monthly: 100 },
		text_classify: { daily: 40, monthly: 100 },
		image_translation: { daily: 20, monthly: 20 },
		live_translation: { daily: 1800, monthly: 1800, total: 1800 }, // 30 mins
		tts: { daily: 200, monthly: 1000 },
		recognition: { daily: 100, monthly: 1000 },
	},
};

export const ENDPOINT_TYPE_MAP: Record<string, ResourceType> = {
	'/translation/text': 'text_translation',
	'/translation/longtext': 'text_translation',
	'/translation/word': 'text_translation',
	'/translation/classify': 'text_classify',
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
