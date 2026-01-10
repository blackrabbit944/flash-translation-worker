import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RevenueCat Webhook Fix', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
	});

	it('returns 400 when app_user_id is missing', async () => {
		const payload = {
			event: {
				type: 'INITIAL_PURCHASE',
				// app_user_id missing
				entitlement_ids: ['pro_member'],
			},
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Before fix: likely 500 due to DB error
		// After fix: 400
		console.log('Response Status:', response.status);
		console.log('Response Body:', await response.text());

		expect(response.status).toBe(400);
	});
});
