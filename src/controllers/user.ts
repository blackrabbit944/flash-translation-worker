import { IRequest } from 'itty-router';
import { AuthenticatedRequest } from '../middleware/auth';
import { getUsageStats } from '../models/usage';
import { TIER_LIMITS, ResourceType } from '../config/limits';

export async function handleGetQuota(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authReq = request as AuthenticatedRequest;

	if (!authReq.userId) {
		return new Response('Unauthorized', { status: 401 });
	}

	const tier = authReq.membershipTier || 'FREE';
	const resourceTypes: ResourceType[] = ['text_translation', 'image_translation', 'live_translation'];

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
			}

			quotas[type] = typeQuota;
		})
	);

	return new Response(
		JSON.stringify({
			tier: tier,
			quotas: quotas,
		}),
		{
			headers: {
				'Content-Type': 'application/json',
			},
		}
	);
}
