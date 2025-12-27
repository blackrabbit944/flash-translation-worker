import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createDb(d1: D1Database) {
	if (!d1) console.error('createDb received undefined D1Database');
	// console.log('createDb received D1Database keys:', Object.keys(d1 || {}));
	return drizzle(d1, { schema });
}
