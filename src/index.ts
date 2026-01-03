import { AutoRouter } from 'itty-router';
import { handleTranslation } from './controllers/translation';
import { handleLogin, handleRefresh } from './controllers/auth';
import { handleRevenueCatWebhook } from './controllers/revenuecat';
import {
	handleTextTranslation,
	handleImageTranslation,
	handleRecognition,
	handleLongTextTranslation,
	handleClassifyText,
	handleWordTranslation,
	handleInputCorrection,
} from './controllers/translation';
import { handleTts, handleTtsPreview, handleTts2 } from './controllers/tts';
import { handleGetQuota, handleInitData } from './controllers/user';
import { withAuth } from './middleware/auth';

const router = AutoRouter();

// @ts-ignore
router.get('/translation/live', withAuth, handleTranslation);
// @ts-ignore
router.post('/translation/correct_input', (req, env, ctx) => handleInputCorrection(req, env, ctx));
// @ts-ignore
router.post('/translation/text', (req, env, ctx) => handleTextTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/classify', (req, env, ctx) => handleClassifyText(req, env, ctx));
// @ts-ignore
router.post('/translation/word', (req, env, ctx) => handleWordTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/longtext', (req, env, ctx) => handleLongTextTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/tts', (req, env, ctx) => handleTts(req, env, ctx));
// @ts-ignore
router.post('/translation/tts2', (req, env, ctx) => handleTts2(req, env, ctx));
// @ts-ignore
router.post('/translation/image', withAuth, (req, env, ctx) => handleImageTranslation(req, env, ctx));
// @ts-ignore
router.post('/translation/recognition', withAuth, (req, env, ctx) => handleRecognition(req, env, ctx));
router.get('/tts/preview', (req, env, ctx) => handleTtsPreview(req, env, ctx));
router.post('/login', (request, env) => handleLogin(request, env));
router.get('/user/quota', withAuth, (request, env, ctx) => handleGetQuota(request, env, ctx));
router.post('/user/init-data', withAuth, (request, env) => handleInitData(request, env));
router.post('/refresh', (request, env) => handleRefresh(request, env));
router.post('/webhooks/revenuecat', (request, env) => handleRevenueCatWebhook(request, env));
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default {
	fetch: router.fetch,
};
