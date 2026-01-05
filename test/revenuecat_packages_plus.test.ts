import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { userEntitlements, users, userUsageStats, userCredits, creditPurchases } from '../src/db/schema';
import { sign } from '../src/utils/jwt';
import { sql, eq, and } from 'drizzle-orm';
import { logUsage, getUsageStats } from '../src/models/usage';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Add-on Packages (Credits) & Usage Deduction', () => {
	let validToken: string;
	const userId = 'user_credits_test';
	const internalId = 'user-credits-uuid-001';

	beforeAll(async () => {
		// Run migrations
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Create User
		const dbUsers = createDb(env.users_db);
		await dbUsers.insert(users).values({ id: internalId, credential: userId }).onConflictDoNothing().execute();

		// Create Token
		const payload = {
			uid: internalId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		validToken = await sign(payload, env.JWT_SECRET);
	});

	beforeEach(async () => {
		// Reset Usage and Credits
		const dbLogs = createDb(env.logs_db);
		await dbLogs.delete(userUsageStats).execute();
		await dbLogs.delete(userCredits).execute();
		await dbLogs.delete(creditPurchases).execute();

		// Reset Entitlements
		const dbUsers = createDb(env.users_db);
		await dbUsers.delete(userEntitlements).execute();
	});

	it('handles credit purchase (1 hour package)', async () => {
		// Simulate Webhook for 1h package
		const purchaseEvent = {
			event: {
				type: 'NON_RENEWING_PURCHASE',
				id: 'evt_pkg_1h',
				transaction_id: 'txn_pkg_1h',
				app_user_id: userId,
				product_id: 'packages_499',
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const req = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(purchaseEvent),
		});

		let ctx = createExecutionContext();
		let res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);

		// Check Credit Balance
		const dbLogs = createDb(env.logs_db);
		const credit = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit).toBeDefined();
		expect(credit?.balanceSeconds).toBe(3600);

		// Check History
		const purchase = await dbLogs.select().from(creditPurchases).where(eq(creditPurchases.id, 'txn_pkg_1h')).get();
		expect(purchase).toBeDefined();
		expect(purchase?.amountSeconds).toBe(3600);
	});

	it('deducts credits only when subscription limit is exceeded', async () => {
		const dbLogs = createDb(env.logs_db);
		const dbUsers = createDb(env.users_db);

		// 1. Give User FREE Tier (default), Limit: 10 mins (600s) daily.
		// Actually FREE tier default live limit is 600s in limits.ts?
		// Let's check limits.ts: FREE live_translation daily: 600 (10 mins)
		// Let's give user some credits (1000s)
		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 1000,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Log usage WITHIN quota (e.g.        // Direct call to logUsage to simulate.
		// We look up DB for Tier.
		await logUsage(env.logs_db, internalId, 'whisper', 0, 0, 0, 'live_translation', 'hash1', 300, 'FREE');

		// Check Usage Stats
		const stats1 = await getUsageStats(env.logs_db, internalId, 'live_translation');
		expect(stats1.daily).toBe(300);

		// Check Credits (Should be UNCHANGED)
		const credit1 = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit1?.balanceSeconds).toBe(1000);

		// 3. Log usage THAT EXCEEDS quota
		// Quota remaining = 600 - 300 = 300s.
		// We log 400s. Total = 700s.
		// Deductible = 700 - 600 = 100s.
		await logUsage(env.logs_db, internalId, 'whisper', 0, 0, 0, 'live_translation', 'hash2', 400, 'FREE');

		// Check Usage Stats
		const stats2 = await getUsageStats(env.logs_db, internalId, 'live_translation');
		expect(stats2.daily).toBe(700);

		// Check Credits (Should be deducted by 100s -> 900s)
		const credit2 = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit2?.balanceSeconds).toBe(900);
	});

	it('allows access via Auth middleware if quota exceeded but has credits', async () => {
		const dbLogs = createDb(env.logs_db);

		// 1. Manually set usage to exceed daily limit (e.g. 700s > 600s limit)
		// Need to insert into userUsageStats
		const now = new Date();
		const yyyy = now.getUTCFullYear();
		const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(now.getUTCDate()).padStart(2, '0');
		const daily = `${yyyy}-${mm}-${dd}`;

		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: internalId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: daily,
				count: 1,
				durationSeconds: 700,
				totalTokens: 0,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Give Credits
		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 50,
				updatedAt: Date.now(),
			})
			.execute();

		// 3. Make API Request (Mocking valid request structure is tricky for full worker fetch, but let's try a simple authenticated request to a route that uses withAuth)
		// We can use the /user/quota endpoint which uses withAuth.
		const req = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET', // translation/live maps to live translation resource
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
		});

		// Current worker routing matches /translation/live to handleLiveTranslation?
		// Actually index.ts uses router.post('/translation/live', ...)
		// Let's assume it attempts logic. Validation might fail but Auth should pass.
		// If Auth fails (Rate Limit), we get 429.

		let ctx = createExecutionContext();
		// We expect this NOT to be 429. It might be 400 or 500 due to body, but not 429.
		// Actually, if we hit handleLiveTranslation, it might proceed.
		// Let's use /translation/text endpoint but force it to be "live_translation" resource type?
		// No, `getResourceTypeFromUrl` works on URL pathname.

		// Let's just create a dummy handler or rely on existing.
		// If we hit /translation/live, we are checking live_translation limit.
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).not.toBe(429);
	});

	it('enforces idempotency on webhooks', async () => {
		// First Purchase
		const event = {
			event: {
				type: 'NON_RENEWING_PURCHASE',
				id: 'evt_idempotency',
				transaction_id: 'txn_idempotency_01',
				app_user_id: userId,
				product_id: 'packages_499',
				purchased_at_ms: Date.now(),
				store: 'app_store',
				environment: 'SANDBOX',
			},
			api_version: '1.0',
		};

		const createReq = () =>
			new IncomingRequest('http://example.com/webhooks/revenuecat', {
				method: 'POST',
				headers: {
					Authorization: env.REVENUECAT_WEBHOOK_SECRET,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(event),
			});

		const ctx1 = createExecutionContext();
		const res1 = await worker.fetch(createReq(), env, ctx1);
		await waitOnExecutionContext(ctx1);
		expect(res1.status).toBe(200);

		// Second Purchase (Same Transaction ID)
		const ctx2 = createExecutionContext();
		const res2 = await worker.fetch(createReq(), env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(res2.status).toBe(200);

		// Verify Credits (Should still be 3600, not 7200)
		const dbLogs = createDb(env.logs_db);
		const credit = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit?.balanceSeconds).toBe(3600);

		// Verify Purchase Logs (Should be 1)
		const purchases = await dbLogs.select().from(creditPurchases).where(eq(creditPurchases.id, 'txn_idempotency_01')).all();
		expect(purchases.length).toBe(1);
	});

	it('denies access (429) if quota exceeded and no credits', async () => {
		const dbLogs = createDb(env.logs_db);

		// 1. Set Usage > Daily Limit (600s)
		const now = new Date();
		const { daily, monthly } = {
			daily: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`,
			monthly: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
		};

		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: internalId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: daily,
				count: 1,
				durationSeconds: 700,
				totalTokens: 0,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Ensure No Credits (or 0 balance)
		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 0,
				updatedAt: Date.now(),
			})
			.execute();

		// 3. Request
		const req = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(429);
	});

	it('fully deducts from credits if already over quota', async () => {
		const dbLogs = createDb(env.logs_db);

		// 1. Initial State: Usage 700 (Over 600 limit), Credits 1000
		const now = new Date();
		const daily = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: internalId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: daily,
				count: 1,
				durationSeconds: 700,
				totalTokens: 0,
				updatedAt: Date.now(),
			})
			.execute();

		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 1000,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Log New Usage (200s)
		// Since already over quota, ENTIRE 200s should be deducted.
		await logUsage(env.logs_db, internalId, 'whisper', 0, 0, 0, 'live_translation', 'hash_full_deduct', 200, 'FREE');

		// 3. Check Credits: 1000 - 200 = 800
		const credit = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit?.balanceSeconds).toBe(800);
	});

	it('deducts credits if monthly limit exceeded but daily is not', async () => {
		const dbLogs = createDb(env.logs_db);

		// 1. Set Monthly Usage > Limit (Free Monthly is 600s too?)
		// Let's check limits.ts details or assume.
		// If FREE Daily=600, Monthly=600.
		// Let's fake usage: Daily = 0, Monthly = 700.
		const now = new Date();
		const { daily, monthly } = {
			daily: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`,
			monthly: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
		};

		// Insert Monthly Stat
		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: internalId,
				endpoint: 'live_translation',
				periodType: 'monthly',
				periodValue: monthly,
				count: 1,
				durationSeconds: 700,
				totalTokens: 0,
				updatedAt: Date.now(),
			})
			.execute();

		// Daily is 0 (by absence)

		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 1000,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Log Usage (50s)
		// Daily (0+50) < 600. OK.
		// Monthly (700+50) > 600. Exceeded.
		// Should deduct 50s.
		await logUsage(env.logs_db, internalId, 'whisper', 0, 0, 0, 'live_translation', 'hash_monthly', 50, 'FREE');

		// 3. Check Credits
		const credit = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit?.balanceSeconds).toBe(950);
	});

	it('allows negative balance for grace period', async () => {
		const dbLogs = createDb(env.logs_db);

		// 1. Set Usage > Limit
		const now = new Date();
		const daily = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: internalId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: daily,
				count: 1,
				durationSeconds: 700,
				totalTokens: 0,
				updatedAt: Date.now(),
			})
			.execute();

		// 2. Set Low Credits (10s)
		await dbLogs
			.insert(userCredits)
			.values({
				userId: internalId,
				balanceSeconds: 10,
				updatedAt: Date.now(),
			})
			.execute();

		// 3. Log Large Usage (60s)
		// Deduct 60s. Balance should be 10 - 60 = -50.
		// System should handle this without throwing error.
		await logUsage(env.logs_db, internalId, 'whisper', 0, 0, 0, 'live_translation', 'hash_negative', 60, 'FREE');

		// 4. Check Credits
		const credit = await dbLogs.select().from(userCredits).where(eq(userCredits.userId, internalId)).get();
		expect(credit?.balanceSeconds).toBe(-50);
	});
});
