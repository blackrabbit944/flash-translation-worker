import { eq } from 'drizzle-orm';
import { createDb } from '../db';
import { users } from '../db/schema';

// Export type inferred from schema
export type User = typeof users.$inferSelect;

export async function findUserByCredential(d1: D1Database, credential: string): Promise<User | null> {
	const db = createDb(d1);
	const result = await db.select().from(users).where(eq(users.credential, credential)).get();
	return result || null;
}

export async function createUser(d1: D1Database, credential: string, userId: string): Promise<User> {
	const db = createDb(d1);
	const newUser = await db.insert(users).values({ id: userId, credential }).returning().get();
	return newUser;
}

export async function updateRefreshToken(d1: D1Database, userId: string, refreshToken: string, expiresAt: number): Promise<void> {
	const db = createDb(d1);
	await db.update(users).set({ refreshToken, refreshTokenExpiresAt: expiresAt }).where(eq(users.id, userId)).execute();
}

export async function findUserByRefreshToken(d1: D1Database, refreshToken: string): Promise<User | null> {
	const db = createDb(d1);
	const result = await db.select().from(users).where(eq(users.refreshToken, refreshToken)).get();
	return result || null;
}
