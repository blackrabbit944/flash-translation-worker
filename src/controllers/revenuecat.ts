import { upsertUserEntitlement } from '../models/subscription';
import { findUserByCredential } from '../models/user';
import { createDb } from '../db';
import { creditPurchases, userCredits } from '../db/schema';
import { sql } from 'drizzle-orm';

export async function handleRevenueCatWebhook(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || authHeader !== env.REVENUECAT_WEBHOOK_SECRET) {
		return new Response('Unauthorized', { status: 401 });
	}

	try {
		const payload = (await request.json()) as any;
		const event = payload.event;

		if (!event) {
			return new Response('Invalid payload', { status: 400 });
		}

		console.log('[revenuecat-event]', event);

		let appUserId = event.app_user_id;

		// Handle TRANSFER events where app_user_id might be missing
		if (!appUserId && event.type === 'TRANSFER' && event.transferred_to && event.transferred_to.length > 0) {
			appUserId = event.transferred_to[0];
			console.log(`[RevenueCat] Resolved app_user_id from transferred_to: ${appUserId}`);
		}

		if (!appUserId) {
			console.error('[RevenueCat] Missing app_user_id in event');
			return new Response('Missing app_user_id', { status: 400 });
		}

		// 1. Resolve internal UUID from credentials (appUserId)
		const user = await findUserByCredential(env.users_db, appUserId);
		const targetUserId = user ? user.id : appUserId;

		const entitlementIds = event.entitlement_ids || [];
		const expirationAtMs = event.expiration_at_ms;

		if (entitlementIds.length > 0) {
			let newStatus = 'active';
			if (event.type === 'EXPIRATION') {
				newStatus = 'expired';
			}

			// Determine if it's a trial and if it's auto-renewing
			// RevenueCat event payload structure:
			// event.period_type: "TRIAL" | "NORMAL" | "INTRO"
			// event.auto_resume_at_ms: (if paused)
			// we can infer autoRenew from "type" usually being CANCELLATION or expiration reasons.
			// But clearer is usually checking `event.is_trial_conversion` or similar, but webhooks vary.
			// Let's rely on `period_type` for trial status.
			const isTrial = event.period_type === 'TRIAL';

			// Auto Renew Logic:
			// If event.type == 'CANCELLATION', it means auto-renew is turned off (usually).
			// If event.type == 'EXPIRATION', it's done.
			// If event.type == 'RENEWAL' or 'INITIAL_PURCHASE', it's usually on.
			// However, RevenueCat webhook doesn't explicitly send "auto_renew_status" boolean in the root event object always.
			// But `event.type` 'CANCELLATION' specifically means "user turned off auto renew".
			// So if we see CANCELLATION, autoRenew = false.
			// If we see INITIAL_PURCHASE or RENEWAL, autoRenew = true (default).
			// If we see EXPIRATION, it doesn't matter much but effectively false.
			let autoRenew = true;
			if (event.type === 'CANCELLATION' || event.type === 'EXPIRATION') {
				autoRenew = false;
			}
			// If we want to be sticky, we should check previous state, but upsert overwrites.
			// The critical case is: User is in TRIAL, and sends CANCELLATION.
			// resulting: isTrial=true, autoRenew=false. This is our "TRIAL_CANCELLED" state.

			for (const entId of entitlementIds) {
				await upsertUserEntitlement(env.users_db, targetUserId, entId, expirationAtMs, newStatus, appUserId, isTrial, autoRenew);
			}

			// Clean up old memberships if this is an upgrade/downgrade (PRODUCT_CHANGE)
			// Priority: UNLIMITED > PRO > LITE
			// Logic: When a new entitlement comes in via PRODUCT_CHANGE, we supersede conflicting ones.
			if (event.type === 'PRODUCT_CHANGE') {
				const hasUnlimited = entitlementIds.includes('unlimited_member');
				const hasPro = entitlementIds.includes('pro_member');
				const hasLite = entitlementIds.includes('lite_member');

				if (hasUnlimited) {
					// Supersede lower tiers
					await upsertUserEntitlement(env.users_db, targetUserId, 'pro_member', Date.now(), 'superseded', appUserId);
					await upsertUserEntitlement(env.users_db, targetUserId, 'lite_member', Date.now(), 'superseded', appUserId);
				} else if (hasPro) {
					// Supersede lower tiers (lite) and higher tiers (unlimited, if this is a downgrade)
					await upsertUserEntitlement(env.users_db, targetUserId, 'lite_member', Date.now(), 'superseded', appUserId);
					await upsertUserEntitlement(env.users_db, targetUserId, 'unlimited_member', Date.now(), 'superseded', appUserId);
				} else if (hasLite) {
					// Supersede higher tiers (if this is a downgrade)
					await upsertUserEntitlement(env.users_db, targetUserId, 'pro_member', Date.now(), 'superseded', appUserId);
					await upsertUserEntitlement(env.users_db, targetUserId, 'unlimited_member', Date.now(), 'superseded', appUserId);
				}
			}

			// Handle Transfers: Remove entitlements from the previous owner
			if (event.type === 'TRANSFER' && event.transferred_from && event.transferred_from.length > 0) {
				for (const fromUserId of event.transferred_from) {
					for (const entId of entitlementIds) {
						// We set it to 'transferred' or 'expired'.
						// 'transferred' is more explicit why they lost it.
						await upsertUserEntitlement(env.users_db, fromUserId, entId, Date.now(), 'transferred');
					}
				}
			}
		}

		// Handle Consumable Purchases (Add-ons)
		if (event.type === 'NON_RENEWING_PURCHASE') {
			await handleConsumablePurchase(env, targetUserId, event);
		}

		return new Response('OK', { status: 200 });
	} catch (error) {
		console.error('Error processing RevenueCat webhook:', error);
		return new Response('Internal Server Error', { status: 500 });
	}
}

async function handleConsumablePurchase(env: Env, userId: string, event: any) {
	const transactionId = event.transaction_id || event.id; // RC uses transaction_id usually for purchases
	const productId = event.product_id;
	const purchasedAt = event.purchased_at_ms || Date.now();

	let amountSeconds = 0;
	if (productId === 'packages_499') {
		amountSeconds = 3600; // 1 hour
	} else if (productId === 'packages_1999') {
		amountSeconds = 36000; // 10 hours
	} else {
		// Unknown product, maybe ignore?
		console.warn(`[Consumable] Unknown product_id: ${productId}, ignoring.`);
		return;
	}

	const db = createDb(env.logs_db); // Usage logs DB contains credit tables

	// 1. Idempotency Check & Record Purchase
	// Note: D1 via Drizzle transaction() might fail in workers/test env due to BEGIN/COMMIT support.
	// We use explicit check-then-write. Race conditions are rare for single-user receipts.
	try {
		const existing = await db
			.select()
			.from(creditPurchases)
			.where(sql`${creditPurchases.id} = ${transactionId}`)
			.get();

		if (existing) {
			console.log(`[Consumable] Duplicate transaction ${transactionId}, ignoring.`);
			return;
		}

		await db
			.insert(creditPurchases)
			.values({
				id: transactionId,
				userId: userId,
				productId: productId,
				amountSeconds: amountSeconds,
				createdAt: purchasedAt,
				source: 'revenuecat',
			})
			.execute();

		// 2. Update Balance
		await db
			.insert(userCredits)
			.values({
				userId: userId,
				balanceSeconds: amountSeconds,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: userCredits.userId,
				set: {
					balanceSeconds: sql`${userCredits.balanceSeconds} + ${amountSeconds}`,
					updatedAt: Date.now(),
				},
			})
			.execute();

		console.log(`[Consumable] Added ${amountSeconds}s to user ${userId} for product ${productId}.`);
	} catch (e: any) {
		// Fallback for race condition on insert
		if (e.message?.includes('UNIQUE constraint failed') || e.code === 'SQLITE_CONSTRAINT') {
			console.log(`[Consumable] Duplicate transaction ${transactionId} (constraint), ignoring.`);
			return;
		}
		console.error('[Consumable] Error processing purchase:', e);
		throw e;
	}
}
