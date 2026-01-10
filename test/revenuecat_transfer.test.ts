import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('RevenueCat Transfer Webhook', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
	});

	it('handles TRANSFER event successfully', async () => {
		const eventPayload = {
			event_timestamp_ms: 1768015874538,
			app_id: 'app7531664f92',
			id: 'EE5B4364-9490-45AE-A55F-C97D91655C98',
			type: 'TRANSFER',
			environment: 'PRODUCTION',
			transferred_to: ['icloud_C3AB655A94754F72BF321C7B3'],
			transferred_from: ['icloud_5C69A03913DF4AC7917804D11'],
			store: 'APP_STORE',
			subscriber_attributes: {
				$attConsentStatus: { value: 'denied', updated_at_ms: 1768012479088 },
			},
			// Note: app_user_id is MISSING, specific to TRANSFER events potentially
		};

		const request = new IncomingRequest('http://example.com/webhooks/revenuecat', {
			method: 'POST',
			headers: {
				Authorization: env.REVENUECAT_WEBHOOK_SECRET,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ api_version: '1.0', event: eventPayload }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		console.log('Response Status:', response.status);
		console.log('Response Body:', await response.text());

		// We expect this to be processed successfully (200), not rejected.
		expect(response.status).toBe(200);
	});
});
