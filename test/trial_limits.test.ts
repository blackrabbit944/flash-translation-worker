import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userEntitlements, usageLogs, userUsageStats } from '../src/db/schema';
import { sign } from '../src/utils/jwt';
import { eq, and } from 'drizzle-orm';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Trial Cancellation Limits', () => {
	let validToken: string;
	const userId = 'user_trial_cancelled';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Generate token
		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	afterEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	it('enforces 30 min limit for trial cancelled user', async () => {
		// 1. Setup User with Trial Cancelled State
		const db = createDb(env.users_db);
		await db
			.insert(userEntitlements)
			.values({
				userId: userId,
				entitlementId: 'pro_member', // They are technically pro
				status: 'active',
				expiresAt: Date.now() + 86400000,
				isTrial: 1, // In Trial
				autoRenew: 0, // Cancelled Auto Renew
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Mock usage to be near limit (e.g. 29 mins used) -> Insert into user_usage_stats
		const logsDb = createDb(env.logs_db);
		const now = new Date();
		const yyyy = now.getUTCFullYear();
		const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
		const dailyKey = `${yyyy}-${mm}-${String(now.getUTCDate()).padStart(2, '0')}`;
		const monthlyKey = `${yyyy}-${mm}`;

		// Insert Monthly Stats (which determines the limit hit)
		await logsDb
			.insert(userUsageStats)
			.values({
				userId: userId,
				endpoint: 'live_translation',
				periodType: 'monthly',
				periodValue: monthlyKey,
				durationSeconds: 1700,
				count: 1,
				updatedAt: Date.now(),
			})
			.execute();

		// Also Daily
		await logsDb
			.insert(userUsageStats)
			.values({
				userId: userId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: dailyKey,
				durationSeconds: 1700,
				count: 1,
				updatedAt: Date.now(),
			})
			.execute();

		// 3. Request Quota endpoint to verify UI sees the limit
		const reqQuota = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${validToken}` },
		});
		const ctxQuota = createExecutionContext();
		const resQuota = await worker.fetch(reqQuota, env, ctxQuota);
		await waitOnExecutionContext(ctxQuota);

		expect(resQuota.status).toBe(200);
		const quotaBody = (await resQuota.json()) as any;

		// Expect limit to be 1800, not the PRO limit (7200)
		expect(quotaBody.quotas.live_translation.monthly.limit).toBe(1800);
		expect(quotaBody.is_trial_cancelled).toBe(true);
		expect(quotaBody.tier).toBe('TRIAL_CANCELLED');
		// Verify other limits match the TRIAL_CANCELLED config
		expect(quotaBody.quotas.text_translation.daily.limit).toBe(40);

		// 4. Exceed the limit by adding more usage to aggregated stats
		await logsDb
			.update(userUsageStats)
			.set({ durationSeconds: 2000 }) // Set to > 1800
			.where(
				and(eq(userUsageStats.userId, userId), eq(userUsageStats.endpoint, 'live_translation'), eq(userUsageStats.periodType, 'monthly'))
			)
			.execute();

		// Ensure Daily is also updated just in case logic falls back
		await logsDb
			.update(userUsageStats)
			.set({ durationSeconds: 2000 })
			.where(
				and(eq(userUsageStats.userId, userId), eq(userUsageStats.endpoint, 'live_translation'), eq(userUsageStats.periodType, 'daily'))
			)
			.execute();

		// 5. Try to use service (e.g. live translation init, or just check auth)
		// Effectively check if `withAuth` blocks it.
		// We can test `withAuth` via any protected endpoint, e.g. /translation/live (GET)
		const reqLive = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET',
			headers: { Authorization: `Bearer ${validToken}` },
		});
		const ctxLive = createExecutionContext();
		const resLive = await worker.fetch(reqLive, env, ctxLive);
		await waitOnExecutionContext(ctxLive);

		// Should be 429
		expect(resLive.status).toBe(429);
		expect(await resLive.text()).toContain('limit exceeded');
	});
});
