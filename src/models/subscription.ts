import { eq, sql } from 'drizzle-orm';
import { createDb } from '../db';
import { userEntitlements } from '../db/schema';

export type UserEntitlement = typeof userEntitlements.$inferSelect;

export async function upsertUserEntitlement(
	d1: D1Database,
	userId: string,
	entitlementId: string,
	expiresAt: number | null,
	status: string,
	originalAppUserId?: string,
	isTrial: boolean = false,
	autoRenew: boolean = true
): Promise<void> {
	const db = createDb(d1);
	await db
		.insert(userEntitlements)
		.values({
			userId,
			entitlementId,
			expiresAt,
			status,
			updatedAt: Date.now(),
			originalAppUserId,
			isTrial: isTrial ? 1 : 0,
			autoRenew: autoRenew ? 1 : 0,
		})
		.onConflictDoUpdate({
			target: [userEntitlements.userId, userEntitlements.entitlementId],
			set: {
				expiresAt: sql`excluded.expires_at`,
				status: sql`excluded.status`,
				updatedAt: sql`excluded.updated_at`,
				originalAppUserId: sql`excluded.original_app_user_id`,
				isTrial: sql`excluded.is_trial`,
				autoRenew: sql`excluded.auto_renew`,
			},
		})
		.execute();
}

export async function getUserEntitlements(d1: D1Database, userId: string): Promise<UserEntitlement[]> {
	const db = createDb(d1);
	return await db.select().from(userEntitlements).where(eq(userEntitlements.userId, userId)).all();
}
