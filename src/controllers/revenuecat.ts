import { upsertUserEntitlement } from '../models/subscription';
import { findUserByCredential } from '../models/user';

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
		const appUserId = event.app_user_id;

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

			for (const entId of entitlementIds) {
				await upsertUserEntitlement(env.users_db, targetUserId, entId, expirationAtMs, newStatus, appUserId);
			}

			// Clean up old memberships if this is an upgrade (PRODUCT_CHANGE to UNLIMITED)
			if (event.type === 'PRODUCT_CHANGE' && entitlementIds.includes('unlimited_member')) {
				await upsertUserEntitlement(env.users_db, targetUserId, 'pro_member', Date.now(), 'superseded', appUserId);
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

		return new Response('OK', { status: 200 });
	} catch (error) {
		console.error('Error processing RevenueCat webhook:', error);
		return new Response('Internal Server Error', { status: 500 });
	}
}
