import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { sign } from '../src/utils/jwt';
import { createDb } from '../src/db';
import { usageLogs, userEntitlements } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import * as Usage from '../src/models/usage';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Live Translation API (Placeholder Verification)', () => {
	let validToken: string;
	const userId = 'live_usage_user';

	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		// Grant PRO entitlement to ensure high limits
		const usersDb = createDb(env.users_db);
		await usersDb
			.insert(userEntitlements)
			.values({
				userId: userId,
				entitlementId: 'pro_membership',
				status: 'active',
				expiresAt: Date.now() + 3600 * 1000,
			})
			.execute();

		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);

		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		validToken = await sign(payload, env.JWT_SECRET);
	});

	it('returns 426 Upgrade Required for non-WebSocket requests', async () => {
		const request = new IncomingRequest('http://example.com/translation/live', {
			headers: { Authorization: `Bearer ${validToken}` },
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(426);
		expect(await response.text()).toContain('Please connect via WebSocket');

		// Usage is not logged for failed upgrade
		const db = createDb(env.logs_db);
		const logs = await db.select().from(usageLogs).where(eq(usageLogs.userId, userId)).execute();
		expect(logs.length).toBe(0);
	});

	it('responds with 404 for root route', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('responds with 401 for live route without auth', async () => {
		const request = new IncomingRequest('http://example.com/translation/live');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Missing Authorization header');
	});

	it('responds with 401 for live route with invalid auth', async () => {
		const request = new IncomingRequest('http://example.com/translation/live', {
			headers: { Authorization: 'Bearer invalid-token' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Invalid or expired token');
	});

	it('responds with 429 when rate limit exceeded', async () => {
		const userId = 'limited_user';
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		// Seed 5 usage logs (Live Translation daily limit for FREE is 5)

		// Seed usage to exceed limit (Daily Free Limit is 300 seconds/units?? Check limits.ts. Assuming 300.)
		// getUsageStats uses durationSeconds for live_translation.
		// So we insert one log with > 300 duration.
		await Usage.logUsage(env.logs_db, userId, 'test-model', 10, 10, 20, 'live_translation', undefined, 301);

		const request = new IncomingRequest('http://example.com/translation/live', {
			headers: { Authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		expect(await response.text()).toContain('Daily Rate limit exceeded');
	});

	it('responds with 404 for unknown routes', async () => {
		const request = new IncomingRequest('http://example.com/unknown');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found.');
	});
});
