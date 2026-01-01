import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore
import { createDb } from '../src/db';
import { usageLogs, userEntitlements, userUsageStats } from '../src/db/schema';
import { sign } from '../src/utils/jwt';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function getTodayString() {
	const date = new Date();
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(date.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

describe('Live Translation Quota', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
		await applyD1Migrations(env.words_db, env.WORDS_MIGRATIONS);
		await applyD1Migrations(env.logs_db, env.LOGS_MIGRATIONS);
	});

	it('enforces duration limit for FREE user', async () => {
		const userId = 'test_user_live_free';
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		// Limit is 600s. Seed 601s usage.
		const db = createDb(env.logs_db);
		await db
			.insert(usageLogs)
			.values({
				id: 'log_live_free_1',
				userId: userId,
				endpoint: 'live_translation',
				model: 'test',
				inputTokens: 0,
				outputTokens: 0,
				costMicros: 0,
				durationSeconds: 601,
				createdAt: Date.now(),
			})
			.execute();

		// Seed Aggregated Stats
		await db
			.insert(userUsageStats)
			.values({
				userId: userId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: getTodayString(),
				count: 1,
				durationSeconds: 601,
				totalTokens: 0,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				Upgrade: 'websocket',
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Should be 429 because usage (301) > limit (300)
		expect(response.status).toBe(429);
		const text = await response.text();
		expect(text).toContain('Daily Rate limit exceeded'); // Current logic checks Daily first
	});

	it('allows access if under limit', async () => {
		const userId = 'test_user_live_ok';
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		const db = createDb(env.logs_db);
		await db
			.insert(usageLogs)
			.values({
				id: 'log_live_ok_1',
				userId: userId,
				endpoint: 'live_translation',
				model: 'test',
				inputTokens: 0,
				outputTokens: 0,
				costMicros: 0,
				durationSeconds: 100, // Under 300 limit
				createdAt: Date.now(),
			})
			.execute();

		// Seed Aggregated Stats
		await db
			.insert(userUsageStats)
			.values({
				userId: userId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: getTodayString(),
				count: 1,
				durationSeconds: 100,
				totalTokens: 0,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				Upgrade: 'websocket',
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Should NOT be 429.
		// Note: live_translation handler returns 500/404 if setup fails or mock not setup,
		// but it passes AUTH middleware which is what we are testing.
		expect(response.status).not.toBe(429);
	});

	it('enforces duration limit for PRO user', async () => {
		const userId = 'test_user_live_pro';
		const payload = { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 };
		const token = await sign(payload, env.JWT_SECRET);

		// Make PRO
		const dbUsers = createDb(env.users_db);
		await dbUsers
			.insert(userEntitlements)
			.values({
				userId: userId,
				entitlementId: 'pro_member', // FIXED: pro_member
				status: 'active',
				expiresAt: Date.now() + 10000000,
			})
			.execute();

		// PRO Limit is 7200 daily.
		const dbLogs = createDb(env.logs_db);
		await dbLogs
			.insert(usageLogs)
			.values({
				id: 'log_live_pro_1',
				userId: userId,
				endpoint: 'live_translation',
				model: 'test',
				inputTokens: 0,
				outputTokens: 0,
				costMicros: 0,
				durationSeconds: 7201,
				createdAt: Date.now(),
			})
			.execute();

		// Seed Aggregated Stats
		await dbLogs
			.insert(userUsageStats)
			.values({
				userId: userId,
				endpoint: 'live_translation',
				periodType: 'daily',
				periodValue: getTodayString(),
				count: 1,
				durationSeconds: 7201,
				totalTokens: 0,
			})
			.execute();

		const request = new IncomingRequest('http://example.com/translation/live', {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' },
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(429);
		const text = await response.text();
		expect(text).toContain('Daily Rate limit exceeded');
	});
});
