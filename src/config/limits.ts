export type ResourceType = 'text_translation' | 'image_translation' | 'live_translation';
export type MembershipTier = 'FREE' | 'PRO' | 'UNLIMITED';

export interface Quota {
	daily: number;
	monthly: number;
}

export const TIER_LIMITS: Record<MembershipTier, Record<ResourceType, Quota>> = {
	FREE: {
		text_translation: { daily: 5, monthly: 150 },
		image_translation: { daily: 1, monthly: 30 },
		live_translation: { daily: 5, monthly: 5 },
	},
	PRO: {
		text_translation: { daily: 100, monthly: 3000 },
		image_translation: { daily: 100, monthly: 3000 },
		live_translation: { daily: 120, monthly: 1800 },
	},
	UNLIMITED: {
		text_translation: { daily: 1000, monthly: 30000 },
		image_translation: { daily: 1000, monthly: 30000 },
		live_translation: { daily: 720, monthly: 3500 },
	},
};

export const ENDPOINT_TYPE_MAP: Record<string, ResourceType> = {
	'/translation/text': 'text_translation',
	'/translation/image': 'image_translation',
	'/translation/live': 'live_translation',
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
