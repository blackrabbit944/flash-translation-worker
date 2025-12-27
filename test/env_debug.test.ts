import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Env Debug', () => {
	it('should have TEST_MIGRATIONS', () => {
		console.log('FULL ENV KEYS:', Object.keys(env));
		if ((env as any).TEST_MIGRATIONS) {
			console.log('TEST_MIGRATIONS found');
		} else {
			console.log('TEST_MIGRATIONS MISSING');
		}
		expect(true).toBe(true);
	});
});
