import { upsertUserEntitlement } from '../models/subscription';

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

		const userId = event.app_user_id;
		const entitlementIds = event.entitlement_ids || [];
		const expirationAtMs = event.expiration_at_ms;

		// Map RevenueCat types to our status
		// We fundamentally care if they have access or not.
		// If it's a cancellation or expiration, we might mark as expired.
		// However, usually RevenueCat sends the current state.

		let status = 'active';
		if (event.type === 'CANCELLATION' || event.type === 'EXPIRATION') {
			// For expiration, it's definitely not active.
			// For cancellation, they might still have time left, but usually expiration_at_ms tells the truth.
			// If expiration_at_ms is in the past, it's expired.
		}

		// RevenueCat webhooks can be complex. For this MVP:
		// We trust the entitlements list and expiration date provided in the event if available.
		// Or we might need to fetch the customer info if the webhook is lightweight.
		// Assuming 'event' contains enough info or we simply update based on the event type.

		// A simpler approach for the requested features:
		// Update the specific entitlement related to the product/event.

		// However, the event might affect multiple entitlements or specific ones.
		// Let's iterate over affected entitlements if provided.

		if (entitlementIds.length > 0) {
			// Determine status based on event type
			// INITIAL_PURCHASE, RENEWAL, PRODUCT_CHANGE, UNPAUSED -> active
			// EXPIRATION -> expired
			// CANCELLATION -> active (until expiration), but we might want to flag it?
			// For now, we rely on expiration_at_ms. If it's valid and in future, it's active.

			let newStatus = 'active';
			if (event.type === 'EXPIRATION') {
				newStatus = 'expired';
			}

			for (const entId of entitlementIds) {
				await upsertUserEntitlement(env.users_db, userId, entId, expirationAtMs, newStatus);
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
