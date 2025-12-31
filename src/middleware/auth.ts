import { IRequest } from 'itty-router';
import { verify } from '../utils/jwt';
import { getUserEntitlements } from '../models/subscription';
import { getUsageStats } from '../models/usage';
import { ResourceType, MembershipTier, TIER_LIMITS, getResourceTypeFromUrl } from '../config/limits';

export interface AuthenticatedRequest extends IRequest {
	userId: string;
	membershipTier: MembershipTier;
}

export async function withAuth(request: IRequest, env: Env, ctx: ExecutionContext) {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader) {
		return new Response('Missing Authorization header', { status: 401 });
	}

	// Expect "Bearer <token>" or just "<token>"? Usually Bearer
	// User said "传入的jwt_token,是放在header里面的请求".
	// I will support direct token or Bearer
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

	try {
		const payload = await verify(token, env.JWT_SECRET);
		const userId = payload.uid as string;

		if (!userId) {
			return new Response('Invalid token payload', { status: 401 });
		}

		// Attach userId to request
		(request as AuthenticatedRequest).userId = userId;

		// Check Entitlements
		const entitlements = await getUserEntitlements(env.users_db, userId);

		// Determine Resource Type from URL
		const url = new URL(request.url);
		// @ts-ignore
		const resourceType: ResourceType = getResourceTypeFromUrl(url.pathname);

		// Determine Membership Tier
		let tier: MembershipTier = 'FREE';
		const activeEntitlements = entitlements.filter((e) => e.status === 'active' && (e.expiresAt === null || e.expiresAt > Date.now()));
		const entitlementIds = activeEntitlements.map((e) => e.entitlementId);

		if (entitlementIds.includes('unlimited_member')) {
			tier = 'UNLIMITED';
		} else if (entitlementIds.includes('pro_member')) {
			tier = 'PRO';
		}

		(request as AuthenticatedRequest).membershipTier = tier;

		// Check for Trial Cancellation state (isTrial=1 AND autoRenew=0)
		const isTrialCancelled = activeEntitlements.some((e) => e.isTrial === 1 && e.autoRenew === 0);

		if (isTrialCancelled) {
			tier = 'TRIAL_CANCELLED';
			(request as AuthenticatedRequest).membershipTier = tier;
		}

		// Get Limits (now automatic via tier)
		const limits = TIER_LIMITS[tier][resourceType];

		// Check Rate Limit (Daily and Monthly) + Total if needed
		const needTotal = limits.total !== undefined;
		const usage = await getUsageStats(env.logs_db, userId, resourceType, needTotal);

		if (usage.daily >= limits.daily) {
			console.log('用户超过了日使用量限制');
			return new Response(`Daily Rate limit exceeded for ${tier} tier on ${resourceType}. Limit: ${limits.daily}, Used: ${usage.daily}`, {
				status: 429,
			});
		}

		if (usage.monthly >= limits.monthly) {
			console.log('用户超过了月使用量限制');
			return new Response(
				`Monthly Rate limit exceeded for ${tier} tier on ${resourceType}. Limit: ${limits.monthly}, Used: ${usage.monthly}`,
				{ status: 429 }
			);
		}

		if (limits.total !== undefined && usage.total >= limits.total) {
			console.log('用户超过了总使用量限制');
			return new Response(`Total Usage limit exceeded for ${tier} tier on ${resourceType}. Limit: ${limits.total}, Used: ${usage.total}`, {
				status: 429,
			});
		}
	} catch (err) {
		console.error('Auth error:', err);
		return new Response('Invalid or expired token', { status: 401 });
	}
}
