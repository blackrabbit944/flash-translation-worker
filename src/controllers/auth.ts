import { IRequest } from 'itty-router';
import { createUser, findUserByCredential, findUserByRefreshToken, updateRefreshToken } from '../models/user';
import { sign } from '../utils/jwt';

export async function handleLogin(request: IRequest, env: Env) {
	const body = (await request.json()) as { credential: string };
	const { credential } = body;

	if (!credential) {
		return new Response('Credential is required', { status: 400 });
	}

	if (credential.length !== 32) {
		return new Response('Credential must be a 32-character string', { status: 400 });
	}

	let user = await findUserByCredential(env.users_db, credential);
	let isNewUser = false;

	if (!user) {
		// Create new user (id is a 32-char hex string, different from credential)
		const userId = crypto.randomUUID().replace(/-/g, '');
		user = await createUser(env.users_db, credential, userId);
		isNewUser = true;
	}

	const now = Math.floor(Date.now() / 1000);
	const jwtPayload = {
		uid: user.id,
		exp: now + 30 * 24 * 60 * 60, // 30 days
	};

	const jwtToken = await sign(jwtPayload, env.JWT_SECRET);
	const refreshToken = crypto.randomUUID().replace(/-/g, '');
	const refreshTokenExpiresAt = now + 60 * 24 * 60 * 60; // 60 days (example, user didn't specify, assuming longer than JWT)

	await updateRefreshToken(env.users_db, user.id, refreshToken, refreshTokenExpiresAt * 1000);

	return Response.json({
		user,
		jwt_token: jwtToken,
		refresh_token: refreshToken,
		expire_time: jwtPayload.exp * 1000,
	});
}

export async function handleRefresh(request: IRequest, env: Env) {
	const body = (await request.json()) as { refresh_token: string };
	const { refresh_token } = body;

	if (!refresh_token) {
		return new Response('Refresh token is required', { status: 400 });
	}

	const user = await findUserByRefreshToken(env.users_db, refresh_token);

	if (!user) {
		return new Response('Invalid refresh token', { status: 401 });
	}

	// Check if refresh token is expired
	if (user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < Date.now()) {
		return new Response('Refresh token expired', { status: 401 });
	}

	const now = Math.floor(Date.now() / 1000);
	const jwtPayload = {
		uid: user.id,
		exp: now + 30 * 24 * 60 * 60, // 30 days
	};

	const jwtToken = await sign(jwtPayload, env.JWT_SECRET);
	// Rotate refresh token? User spec doesn't explicitly say to rotate, but usually good practice.
	// Spec says: "续期一样会返回user,jwt_token,refresh_token,expire_time".
	// Implies returning a (possibly new) refresh token. I'll generate a new one.
	const newRefreshToken = crypto.randomUUID().replace(/-/g, '');
	const newRefreshTokenExpiresAt = now + 60 * 24 * 60 * 60; // 60 days

	await updateRefreshToken(env.users_db, user.id, newRefreshToken, newRefreshTokenExpiresAt * 1000);

	// Fetch updated user to return
	const updatedUser = await findUserByCredential(env.users_db, user.credential);

	return Response.json({
		user: updatedUser,
		jwt_token: jwtToken,
		refresh_token: newRefreshToken,
		expire_time: jwtPayload.exp * 1000,
	});
}
