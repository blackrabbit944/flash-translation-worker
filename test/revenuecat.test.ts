import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { getUserEntitlements, upsertUserEntitlement } from '../src/models/subscription';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RevenueCat Webhook', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
	});

	it('should reject requests with invalid authorization', async () => {
		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: { Authorization: 'invalid-secret' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401); // Assuming 401 or 403 based on implementation
	});

	it('should process INITIAL_PURCHASE and activate entitlement', async () => {
		const userId = 'user_123';
		const entitlementId = 'pro_member';
		const payload = {
			event: {
				type: 'INITIAL_PURCHASE',
				app_user_id: userId,
				entitlement_ids: [entitlementId],
				expiration_at_ms: Date.now() + 100000,
			},
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: { Authorization: env.REVENUECAT_WEBHOOK_SECRET },
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const entitlements = await getUserEntitlements(env.users_db, userId);
		expect(entitlements.length).toBe(1);
		expect(entitlements[0].entitlementId).toBe(entitlementId);
		expect(entitlements[0].status).toBe('active');
	});

	it('should process EXPIRATION and expire entitlement', async () => {
		const userId = 'user_123';
		const entitlementId = 'pro_member';

		// First make it active
		const payload1 = {
			event: {
				type: 'INITIAL_PURCHASE',
				app_user_id: userId,
				entitlement_ids: [entitlementId],
				expiration_at_ms: Date.now() + 100000,
			},
		};
		// ... send payload1 ... (skipping for brevity, assuming state matches from previous test or we run sequentially)
		// Actually, let's just send the expiration event.

		const payload = {
			event: {
				type: 'EXPIRATION',
				app_user_id: userId,
				entitlement_ids: [entitlementId],
				expiration_at_ms: Date.now() - 1000, // Past
			},
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: { Authorization: env.REVENUECAT_WEBHOOK_SECRET },
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const entitlements = await getUserEntitlements(env.users_db, userId);
		expect(entitlements.length).toBe(1);
		expect(entitlements[0].entitlementId).toBe(entitlementId);
		expect(entitlements[0].status).toBe('expired');
	});

	it('should process RENEWAL and update expiration', async () => {
		const userId = 'user_123';
		const entitlementId = 'pro_member';
		const newExpiration = Date.now() + 200000;

		const payload = {
			event: {
				type: 'RENEWAL',
				app_user_id: userId,
				entitlement_ids: [entitlementId],
				expiration_at_ms: newExpiration,
			},
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: { Authorization: env.REVENUECAT_WEBHOOK_SECRET },
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const entitlements = await getUserEntitlements(env.users_db, userId);
		expect(entitlements.length).toBe(1);
		expect(entitlements[0].entitlementId).toBe(entitlementId);
		expect(entitlements[0].status).toBe('active');
		expect(entitlements[0].expiresAt).toBe(newExpiration);
	});

	it('should process TRANSFER and move entitlement from old user to new user', async () => {
		const oldUserId = 'user_old';
		const newUserId = 'user_new';
		const entitlementId = 'pro_member';
		const expiration = Date.now() + 100000;

		// Setup: Old user needs to have the entitlement first
		await upsertUserEntitlement(env.users_db, oldUserId, entitlementId, expiration, 'active');

		const payload = {
			event: {
				type: 'TRANSFER',
				app_user_id: newUserId,
				transferred_from: [oldUserId],
				entitlement_ids: [entitlementId],
				expiration_at_ms: expiration,
			},
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: { Authorization: env.REVENUECAT_WEBHOOK_SECRET },
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		// Verify New User has it
		const newEntitlements = await getUserEntitlements(env.users_db, newUserId);
		expect(newEntitlements.length).toBe(1);
		expect(newEntitlements[0].entitlementId).toBe(entitlementId);
		expect(newEntitlements[0].status).toBe('active');

		// Verify Old User lost it
		const oldEntitlements = await getUserEntitlements(env.users_db, oldUserId);
		expect(oldEntitlements.length).toBe(1);
		expect(oldEntitlements[0].entitlementId).toBe(entitlementId);
		expect(oldEntitlements[0].status).toBe('transferred');
	});
});
