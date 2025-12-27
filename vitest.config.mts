import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
	// Read migrations for each DB
	const usersMigrations = await readD1Migrations(path.join(process.cwd(), 'migrations/users'));
	const wordsMigrations = await readD1Migrations(path.join(process.cwd(), 'migrations/words'));
	const logsMigrations = await readD1Migrations(path.join(process.cwd(), 'migrations/usage_logs')); // Renamed logs -> usage_logs

	return {
		test: {
			poolOptions: {
				workers: {
					wrangler: { configPath: './wrangler.jsonc' },
					miniflare: {
						bindings: {
							TEST_MIGRATIONS: usersMigrations,
							WORDS_MIGRATIONS: wordsMigrations,
							LOGS_MIGRATIONS: logsMigrations,
						},
					},
				},
			},
		},
	};
});
