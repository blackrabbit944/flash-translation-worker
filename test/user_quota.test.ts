import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { usageLogs, userEntitlements } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('User Quota API', () => {
	let validToken: string;
	const userId = 'test_user_quota';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('returns correct quota structure for FREE user', async () => {
		//Seed usage via logUsage to ensure stats are updated
		const { logUsage } = await import('../src/models/usage');
		await logUsage(env.logs_db, userId, 'test', 10, 10, 100, 'text_translation');

		const request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${validToken}` },
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;

		expect(body.tier).toBe('FREE');
		expect(body.quotas).toBeDefined();

		// Text Translation (Free limit 300 daily)
		const textQuota = body.quotas.text_translation;
		expect(textQuota).toBeDefined();
		expect(textQuota.daily.limit).toBe(3);
		expect(textQuota.daily.used).toBe(1);
		expect(textQuota.daily.remaining).toBe(2);

		// Total limit should exist for FREE user
		expect(textQuota.total).toBeDefined();
		expect(textQuota.total.limit).toBe(10);
		expect(textQuota.total.used).toBe(1);
		expect(textQuota.total.remaining).toBe(9);

		// Other types should exist
		expect(body.quotas.image_translation).toBeDefined();
		expect(body.quotas.live_translation).toBeDefined();
	});
	it('returns correct quota structure for PRO user', async () => {
		const proUserId = 'test_user_quota_pro';
		const payload = { uid: proUserId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const proToken = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.users_db);
		await db
			.insert(userEntitlements)
			.values({
				userId: proUserId,
				entitlementId: 'pro_membership',
				status: 'active',
				expiresAt: Date.now() + 10000000,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${proToken}` },
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;

		expect(body.tier).toBe('PRO');

		// Text Translation (Pro limit 100 daily)
		const textQuota = body.quotas.text_translation;
		expect(textQuota).toBeDefined();
		expect(textQuota.daily.limit).toBe(100);

		// PRO should NOT have total limit
		expect(textQuota.total).toBeUndefined();
	});
});
