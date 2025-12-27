import { AutoRouter } from 'itty-router';
import { handleTranslation } from './controllers/translation';
import { handleLogin, handleRefresh } from './controllers/auth';
import { handleRevenueCatWebhook } from './controllers/revenuecat';
import { handleTextTranslation, handleImageTranslation } from './controllers/translation';
import { withAuth } from './middleware/auth';

const router = AutoRouter();

// @ts-ignore
router.get('/translation/live', withAuth, handleTranslation);
// @ts-ignore
router.post('/translation/text', withAuth, (req, env, ctx) => handleTextTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/image', withAuth, (req, env, ctx) => handleImageTranslation(req, env, ctx));
router.post('/login', (request, env) => handleLogin(request, env));
router.post('/refresh', (request, env) => handleRefresh(request, env));
router.post('/webhooks/revenuecat', (request, env) => handleRevenueCatWebhook(request, env));
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default {
	fetch: router.fetch,
};
