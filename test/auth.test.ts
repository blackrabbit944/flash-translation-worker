import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-ignore

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Auth', () => {
	beforeAll(async () => {
		await applyD1Migrations(env.users_db, env.TEST_MIGRATIONS);
	});

	it('login creates a new user and returns tokens', async () => {
		const credential = 'icloud_test_credential_1_32chars';
		const request = new IncomingRequest('http://example.com/login', {
			method: 'POST',
			body: JSON.stringify({ credential }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as any;
		expect(body.user).toBeDefined();
		expect(body.user.credential).toBe(credential);
		expect(body.jwt_token).toBeDefined();
		expect(body.refresh_token).toBeDefined();
		expect(body.expire_time).toBeDefined();
	});

	it('login with existing user returns tokens', async () => {
		const credential = 'icloud_test_credential_1_32chars'; // Same as above
		const request = new IncomingRequest('http://example.com/login', {
			method: 'POST',
			body: JSON.stringify({ credential }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as any;
		expect(body.user.credential).toBe(credential);
	});

	it('refresh token renews jwt and refresh token', async () => {
		// First login to get tokens
		const credential = 'icloud_test_credential_2_32chars';
		const loginReq = new IncomingRequest('http://example.com/login', {
			method: 'POST',
			body: JSON.stringify({ credential }),
		});
		const ctx1 = createExecutionContext();
		const loginRes = await worker.fetch(loginReq, env, ctx1);
		await waitOnExecutionContext(ctx1);
		const loginBody = (await loginRes.json()) as any;
		const refreshToken = loginBody.refresh_token;

		// Now refresh
		const refreshReq = new IncomingRequest('http://example.com/refresh', {
			method: 'POST',
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
		const ctx2 = createExecutionContext();
		const refreshRes = await worker.fetch(refreshReq, env, ctx2);
		await waitOnExecutionContext(ctx2);

		expect(refreshRes.status).toBe(200);
		const refreshBody = (await refreshRes.json()) as any;
		expect(refreshBody.jwt_token).toBeDefined();
		expect(refreshBody.refresh_token).toBeDefined();
		expect(refreshBody.refresh_token).not.toBe(refreshToken); // Should be rotated
		expect(refreshBody.user.credential).toBe(credential);
	});

	it('invalid refresh token returns 401', async () => {
		const refreshReq = new IncomingRequest('http://example.com/refresh', {
			method: 'POST',
			body: JSON.stringify({ refresh_token: 'invalid_token' }),
		});
		const ctx = createExecutionContext();
		const refreshRes = await worker.fetch(refreshReq, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(refreshRes.status).toBe(401);
	});
});
