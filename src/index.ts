import { AutoRouter } from 'itty-router';
import { handleTranslation } from './controllers/translation';
import { handleLogin, handleRefresh } from './controllers/auth';
import { handleRevenueCatWebhook } from './controllers/revenuecat';
import { handleTextTranslation, handleImageTranslation } from './controllers/translation';
import { handleTts, handleTtsPreview } from './controllers/tts';
import { handleGetQuota } from './controllers/user';
import { withAuth } from './middleware/auth';

const router = AutoRouter();

// @ts-ignore
router.get('/translation/live', withAuth, handleTranslation);
// @ts-ignore
router.post('/translation/text', (req, env, ctx) => handleTextTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/tts', (req, env, ctx) => handleTts(req, env, ctx));
// @ts-ignore
router.post('/translation/image', withAuth, (req, env, ctx) => handleImageTranslation(req, env, ctx));
router.get('/tts/preview', (req, env, ctx) => handleTtsPreview(req, env, ctx));
router.post('/login', (request, env) => handleLogin(request, env));
router.get('/user/quota', withAuth, (request, env, ctx) => handleGetQuota(request, env, ctx));
router.post('/refresh', (request, env) => handleRefresh(request, env));
router.post('/webhooks/revenuecat', (request, env) => handleRevenueCatWebhook(request, env));
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default {
	fetch: router.fetch,
};
