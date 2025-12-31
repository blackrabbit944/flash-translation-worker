import { IRequest } from 'itty-router';
import { AuthenticatedRequest } from '../middleware/auth';
import { getUsageStats } from '../models/usage';
import { getUserEntitlements } from '../models/subscription';
import { TIER_LIMITS, ResourceType } from '../config/limits';
import { saveUserInitData } from '../models/init_data';

export async function handleGetQuota(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	let tier = authReq.membershipTier || 'FREE';
	const resourceTypes: ResourceType[] = ['text_translation', 'image_translation', 'live_translation'];

	// Needed for expiration date
	const entitlements = await getUserEntitlements(env.users_db, authReq.userId);
	const activeEntitlements = entitlements.filter((e) => e.status === 'active' && (e.expiresAt === null || e.expiresAt > Date.now()));

	// Check for Trial Cancellation state (isTrial=1 AND autoRenew=0)
	// We check if ANY active entitlement is a cancelled trial.
	// Usually there is only 1 active main entitlement.
	const isTrialCancelled = activeEntitlements.some((e) => e.isTrial === 1 && e.autoRenew === 0);

	if (isTrialCancelled) {
		tier = 'TRIAL_CANCELLED';
	}

	const quotas: Record<string, any> = {};

	await Promise.all(
		resourceTypes.map(async (type) => {
			const limitConfig = TIER_LIMITS[tier][type];
			// If total limit is defined, we need to fetch total usage stats
			const needTotal = limitConfig.total !== undefined;
			const stats = await getUsageStats(env.logs_db, authReq.userId, type, needTotal);

			const typeQuota: any = {
				daily: {
					limit: limitConfig.daily,
					remaining: Math.max(0, limitConfig.daily - stats.daily),
					used: stats.daily,
				},
				monthly: {
					limit: limitConfig.monthly,
					remaining: Math.max(0, limitConfig.monthly - stats.monthly),
					used: stats.monthly,
				},
			};

			if (limitConfig.total !== undefined) {
				typeQuota.total = {
					limit: limitConfig.total,
					remaining: Math.max(0, limitConfig.total - stats.total),
					used: stats.total,
				};
			} else {
				// If no total limit is defined (e.g. Pro/Unlimited), return -1 to indicate unlimited
				typeQuota.total = {
					limit: -1,
					remaining: -1,
					used: stats.total,
				};
			}

			quotas[type] = typeQuota;
		})
	);

	// Calculate expiration date based on the active entitlement that determined the tier
	let expirationTimestamp: number | null = null;
	const definingEntitlementId = tier === 'UNLIMITED' ? 'unlimited_member' : tier === 'PRO' ? 'pro_member' : null;

	if (definingEntitlementId) {
		const ent = activeEntitlements.find((e) => e.entitlementId === definingEntitlementId);
		if (ent && ent.expiresAt) {
			expirationTimestamp = ent.expiresAt;
		}
	}

	return new Response(
		JSON.stringify({
			tier: tier,
			membership_expire_at: expirationTimestamp,
			is_trial_cancelled: isTrialCancelled,
			quotas: quotas,
		}),
		{
			headers: {
				'Content-Type': 'application/json',
			},
		}
	);
}

export async function handleInitData(request: IRequest, env: Env) {
	const authReq = request as AuthenticatedRequest;
	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	try {
		const body = (await request.json()) as any;
		// Basic validation could go here, but for analysis data we can be flexible.
		// We expect the keys to match what the user sends (snake_case from request, map to camelCase for internal).

		await saveUserInitData(env.users_db, authReq.userId, {
			sourceLanguage: body.source_language,
			targetLanguage: body.target_language,
			whyUse: body.why_use,
			howToKnown: body.how_to_known,
		});

		return new Response(JSON.stringify({ success: true }), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (e) {
		console.error('Error saving init data:', e);
		return new Response('Internal Server Error', { status: 500 });
	}
}
