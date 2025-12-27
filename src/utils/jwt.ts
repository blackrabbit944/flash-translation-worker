export async function sign(payload: any, secret: string): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const encodedHeader = btoa(JSON.stringify(header));
	const encodedPayload = btoa(JSON.stringify(payload));
	const data = `${encodedHeader}.${encodedPayload}`;

	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

	return `${data}.${encodedSignature}`;
}

export async function verify(token: string, secret: string): Promise<any> {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid token format');
	}

	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const data = `${encodedHeader}.${encodedPayload}`;

	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

	const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

	const isValid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(data));

	if (!isValid) {
		throw new Error('Invalid signature');
	}

	return JSON.parse(atob(encodedPayload));
}
