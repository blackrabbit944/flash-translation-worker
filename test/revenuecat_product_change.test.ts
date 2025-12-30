import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userEntitlements, users } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RevenueCat Product Change & Auth Priority', () => {
	let validToken: string;
	const userId = 'test_rc_upgrade_user';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Generate token
		const payload = {
			uid: userId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('prioritizes UNLIMITED over PRO when both exist', async () => {
		const db = createDb(env.users_db);

		// Pre-create user to ensure FIND by credential works
		// The webhook logic now tries to find the user by credential (app_user_id)
		// So we must have a user in the DB with `credential` = userId (from the test setup)
		// In this test, `userId` variable is holding 'test_rc_upgrade_user' which acts as the credential.
		// We need to insert a user record for it.
		const internalId = 'user-uuid-123';
		await db
			.insert(users)
			.values({
				id: internalId,
				credential: userId, // 'test_rc_upgrade_user'
			})
			.execute();

		// 1. Initial State: User has PRO membership linked to their UUID
		await db
			.insert(userEntitlements)
			.values({
				userId: internalId, // UUID
				entitlementId: 'pro_member',
				status: 'active',
				expiresAt: Date.now() + 10000000,
				originalAppUserId: userId, // 'test_rc_upgrade_user'
			})
			.execute();

		// check quota linked to UUID -> should be PRO
		// Token must be signed for the UUID now
		const payload = {
			uid: internalId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		const uuidToken = await sign(payload, env.JWT_SECRET);

		let request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${uuidToken}` },
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		let body = (await response.json()) as any;
		expect(body.tier).toBe('PRO');

		// 2. Simulate Webhook: PRODUCT_CHANGE to UNLIMITED
		// RevenueCat sends the CREDENTIAL (userId)
		const webhookPayload = {
			event: {
				type: 'PRODUCT_CHANGE',
				id: 'evt_1234567890',
				app_user_id: userId,
				original_app_user_id: userId,
				product_id: 'com.flash.unlimited.yearly',
				entitlement_ids: ['unlimited_member'], // New entitlement
				expiration_at_ms: Date.now() + 31536000000, // 1 year later
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const webhookReq = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET, // Mock secret in test env?
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(webhookPayload),
		});
		ctx = createExecutionContext();
		response = await worker.fetch(webhookReq, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		// 3. Verify DB State: BOTH should be active (old PRO + new UNLIMITED)
		// because our webhook doesn't explicitly turn off the old one.
		// UPDATE: Now we expect PRO to be superseded
		const entitlements = await db
			.select()
			.from(userEntitlements)
			.where(sql`user_id = ${internalId}`) // Check by UUID
			.all();

		// Fix: Use more robust check
		const pro = entitlements.find((e) => e.entitlementId === 'pro_member');
		const unlimited = entitlements.find((e) => e.entitlementId === 'unlimited_member');

		expect(pro).toBeDefined();
		expect(pro?.status).toBe('superseded');
		expect(unlimited).toBeDefined();
		expect(unlimited?.status).toBe('active');

		// 4. Verify Auth Logic: Should be UNLIMITED due to priority
		request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${uuidToken}` },
		});
		ctx = createExecutionContext();
		response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		body = (await response.json()) as any;

		expect(body.tier).toBe('UNLIMITED');
	});
});

import { sql } from 'drizzle-orm';
