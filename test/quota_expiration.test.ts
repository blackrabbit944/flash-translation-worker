import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userEntitlements } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('User Quota API with Expiration', () => {
	let validToken: string;
	const userId = 'test_quota_expiration_user';
	const futureTime = Date.now() + 10000000;

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('returns membership_expire_at for active subscription', async () => {
		const db = createDb(env.users_db);
		await db
			.insert(userEntitlements)
			.values({
				userId,
				entitlementId: 'pro_member',
				status: 'active',
				expiresAt: futureTime,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${validToken}` },
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;

		expect(body.tier).toBe('PRO');
		expect(body.membership_expire_at).toBe(futureTime);
		// Verify total is present (fix for Swift client)
		expect(body.quotas.text_translation.total).toBeDefined();
		expect(body.quotas.text_translation.total.limit).toBe(-1);
	});
});
