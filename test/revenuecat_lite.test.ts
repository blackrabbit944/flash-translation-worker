import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userEntitlements, users } from '../src/db/schema';
import { sign } from '../src/utils/jwt';
import { sql, eq } from 'drizzle-orm';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RevenueCat Lite Membership & Transitions', () => {
	let validToken: string;
	const userId = 'test_rc_lite_user';
	const internalId = 'user-lite-uuid-456';

	beforeAll(async () => {
		// Migrations run once per file usually, but D1 state might reset.
		// Cloudflare vitest environment typically resets D1 per test depending on config.
		// Safest is to treat each test as fresh or ensure setup.
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = {
			uid: internalId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	// Helper to ensure user exists
	async function ensureUserExists() {
		const db = createDb(env.users_db);
		const user = await db.select().from(users).where(eq(users.id, internalId)).get();
		if (!user) {
			await db.insert(users).values({ id: internalId, credential: userId }).execute();
		}
	}

	it('grants LITE tier benefits via lite_member entitlement', async () => {
		await ensureUserExists();

		// Simulate Webhook: Purchase LITE
		const webhookPayload = {
			event: {
				type: 'INITIAL_PURCHASE',
				id: 'evt_lite_1',
				app_user_id: userId,
				product_id: 'com.flash.lite.monthly',
				entitlement_ids: ['lite_member'],
				expiration_at_ms: Date.now() + 2592000000,
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const webhookReq = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(webhookPayload),
		});
		let ctx = createExecutionContext();
		let response = await worker.fetch(webhookReq, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		// Verify Quota
		const request = new IncomingRequest('http://example.com/user/quota', {
			method: 'GET',
			headers: { Authorization: `Bearer ${validToken}` },
		});
		ctx = createExecutionContext();
		response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = (await response.json()) as any;

		expect(body.tier).toBe('LITE');
		// Check defaults from limits.ts
		expect(body.quotas.text_translation.daily.limit).toBe(60);
		expect(body.quotas.live_translation.daily.limit).toBe(3600);
	});

	it('Supersedes LITE when upgrading to PRO', async () => {
		const db = createDb(env.users_db);
		await ensureUserExists();

		// Setup: Active LITE member
		await db
			.insert(userEntitlements)
			.values({
				userId: internalId,
				entitlementId: 'lite_member',
				status: 'active',
				expiresAt: Date.now() + 1000000,
				updatedAt: Date.now(),
				isTrial: 0,
				autoRenew: 1,
			})
			.execute();

		// Simulate Webhook: Upgrade to PRO
		const webhookPayload = {
			event: {
				type: 'PRODUCT_CHANGE',
				id: 'evt_up_pro',
				app_user_id: userId,
				product_id: 'com.flash.pro.monthly',
				entitlement_ids: ['pro_member'], // New entitlement
				expiration_at_ms: Date.now() + 2592000000,
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const webhookReq = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(webhookPayload),
		});
		let ctx = createExecutionContext();
		const response = await worker.fetch(webhookReq, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		// Verify DB State
		const entitlements = await db
			.select()
			.from(userEntitlements)
			.where(sql`user_id = ${internalId}`)
			.all();

		const lite = entitlements.find((e) => e.entitlementId === 'lite_member');
		const pro = entitlements.find((e) => e.entitlementId === 'pro_member');

		expect(lite).toBeDefined();
		expect(lite?.status).toBe('superseded');
		expect(pro).toBeDefined();
		expect(pro?.status).toBe('active');
	});

	it('Supersedes PRO when downgrading to LITE', async () => {
		const db = createDb(env.users_db);
		await ensureUserExists();

		// Setup: Active PRO member
		await db
			.insert(userEntitlements)
			.values({
				userId: internalId,
				entitlementId: 'pro_member',
				status: 'active',
				expiresAt: Date.now() + 1000000,
				updatedAt: Date.now(),
				isTrial: 0,
				autoRenew: 1,
			})
			.execute();

		// Simulate Webhook: Downgrade to LITE
		const webhookPayload = {
			event: {
				type: 'PRODUCT_CHANGE',
				id: 'evt_down_lite',
				app_user_id: userId,
				product_id: 'com.flash.lite.monthly',
				entitlement_ids: ['lite_member'],
				expiration_at_ms: Date.now() + 2592000000,
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const webhookReq = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(webhookPayload),
		});
		let ctx = createExecutionContext();
		const response = await worker.fetch(webhookReq, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		// Verify DB State
		const entitlements = await db
			.select()
			.from(userEntitlements)
			.where(sql`user_id = ${internalId}`)
			.all();

		const lite = entitlements.find((e) => e.entitlementId === 'lite_member');
		const pro = entitlements.find((e) => e.entitlementId === 'pro_member');

		expect(pro).toBeDefined();
		expect(pro?.status).toBe('superseded');
		expect(lite).toBeDefined();
		expect(lite?.status).toBe('active');
	});
});
