interface Env {
	GEMINI_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// 1. 检查是否为 WebSocket 请求
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('请通过 WebSocket 连接', { status: 426 });
		}

		// 2. 解析查询参数中的语言设置
		const params = url.searchParams;
		const sourceLangName = params.get('sourceLanguage') || 'English';
		const targetLangName = params.get('targetLanguage') || 'Chinese';

		const voiceParam = params.get('voice');
		const allowedVoices = ['Kore'];
		const voiceName = voiceParam && allowedVoices.includes(voiceParam) ? voiceParam : 'Kore';

		// 3. 构造 System Prompt
		const systemPrompt = `
你是专业的双向实时语音翻译员。
你将听到 ${sourceLangName} 或 ${targetLangName} 的语音。
你必须检测语言并将其翻译成另一种语言（${sourceLangName} -> ${targetLangName} 或 ${targetLangName} -> ${sourceLangName}）。
仅输出翻译后的文本和音频。不要回复对话性文本，只提供翻译。

1.因此请你根据前后文进行翻译。
2.你听到的两种语言分别是2个不同身份的人在说话,所以你要理解这两个人的关系进行翻译.
3.如果说A语言,一定要翻译成B语言,无论说什么都不要理解回复,而是直接翻译.
4.如果说B语言,一定要翻译成A语言,无论说什么都不要理解回复,而是直接翻译.
`;

		// 4. 构造 Setup 消息
		const setupToGemini = {
			setup: {
				model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
				generationConfig: {
					responseModalities: ['AUDIO'],
					speechConfig: {
						voiceConfig: {
							prebuiltVoiceConfig: {
								voiceName: voiceName,
							},
						},
					},
				},
				systemInstruction: {
					parts: [{ text: systemPrompt }],
				},
				realtimeInputConfig: {
					automaticActivityDetection: {
						// 假设 shouldDisableVAD 默认为 true 或者是 false?
						// 用户代码里: automaticActivityDetection: shouldDisableVAD
						// 而 Setup 里的 automaticActivityDetection: [ disabled: automaticActivityDetection ]
						// 如果用户想开启 VAD (Voice Activity Detection), disabled 应该是 false.
						// 用户代码: automaticActivityDetection: shouldDisableVAD (param name in init is automaticActivityDetection, but mapped to "disabled" in JSON)
						// 让我们假设我们想开启 VAD 以便自动检测, 除非用户特别要在 URL 里关掉
						// 这里暂时默认开启 VAD (disabled: false), 如果需要禁用 VAD，URL 参数可以传 vad_disabled=true
						disabled: true,
						startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
						endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', // requested
						prefixPaddingMs: 20,
						silenceDurationMs: 1000, // requested
					},
				},
				// input_audio_transcription & output_audio_transcription requested as true
				inputAudioTranscription: {},
				outputAudioTranscription: {},
			},
		};

		// 5. 连接 Google 服务端 (v1beta)
		const targetUrl =
			'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
			env.GEMINI_API_KEY;

		try {
			const response = await fetch(targetUrl, {
				headers: request.headers,
				// @ts-ignore - CF specific
				webSocket: true,
			});

			const serverWebSocket = response.webSocket;
			if (!serverWebSocket) {
				return new Response('无法初始化 Google 后端连接', { status: 500 });
			}

			// 6. 创建与客户端（App）的连接
			const pair = new WebSocketPair();
			const client = pair[0];
			const worker = pair[1];
			worker.accept();
			serverWebSocket.accept();

			// 7. 发送 Setup 消息给 Google
			serverWebSocket.send(JSON.stringify(setupToGemini));

			// 8. 双向数据转发
			worker.addEventListener('message', (event) => {
				const data = event.data;

				// 拦截客户端发的 setup 消息
				if (typeof data === 'string') {
					try {
						const json = JSON.parse(data);
						if (json.setup) {
							// 丢弃客户端的 setup，因为我们已经发送了自己的
							// console.log('Dropped client setup message');
							return;
						}
					} catch (e) {
						// 不是 JSON，或者是部分 JSON，直接转发
					}
					serverWebSocket.send(data);
				} else {
					// 二进制或者其他类型直接转发
					serverWebSocket.send(data);
				}
			});

			serverWebSocket.addEventListener('message', (event) => {
				worker.send(event.data);
			});

			// 9. 异常处理：任意一方关闭，则全部关闭
			const closeHandler = () => {
				try {
					worker.close();
				} catch {}
				try {
					serverWebSocket.close();
				} catch {}
			};
			worker.addEventListener('close', closeHandler);
			serverWebSocket.addEventListener('close', closeHandler);
			worker.addEventListener('error', closeHandler);
			serverWebSocket.addEventListener('error', closeHandler);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		} catch (err) {
			return new Response('连接失败: ' + (err as Error).message, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
