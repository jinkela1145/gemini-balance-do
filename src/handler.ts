import { DurableObject } from 'cloudflare:workers';
import { isAdminAuthenticated } from './auth';

class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = this.constructor.name;
		this.status = status;
	}
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
	return { headers: newHeaders, status, statusText };
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const API_CLIENT = 'genai-js/0.21.0';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});

/** A Durable Object's behavior is defined in an exported Javascript class */
export class LoadBalancer extends DurableObject {
	env: Env;
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		// Initialize the database schema upon first creation.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				api_key TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS api_key_statuses (
				api_key TEXT PRIMARY KEY,
				status TEXT CHECK(status IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				last_checked_at INTEGER,
				failed_count INTEGER NOT NULL DEFAULT 0,
				key_group TEXT CHECK(key_group IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				usage_count INTEGER NOT NULL DEFAULT 0,
				response_time_avg INTEGER NOT NULL DEFAULT 0,
				last_used_at INTEGER,
				FOREIGN KEY(api_key) REFERENCES api_keys(api_key) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS request_stats (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				api_key TEXT,
				model TEXT,
				prompt_tokens INTEGER DEFAULT 0,
				completion_tokens INTEGER DEFAULT 0,
				response_time_ms INTEGER,
				status_code INTEGER,
				created_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS rate_limits (
				identifier TEXT PRIMARY KEY,
				request_count INTEGER DEFAULT 0,
				window_start INTEGER
			);
		`);
		this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000); // Set an alarm to run in 5 minutes
	}


	async alarm() {
		// 1. Handle abnormal keys
		const abnormalKeys = await this.ctx.storage.sql
			.exec("SELECT api_key, failed_count FROM api_key_statuses WHERE key_group = 'abnormal'")
			.raw<any>();

		for (const row of Array.from(abnormalKeys)) {
			const apiKey = row[0] as string;
			const failedCount = row[1] as number;

			try {
				const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: 'hi' }] }],
					}),
				});
				if (response.ok) {
					// Key is working again, move it back to the normal group
					await this.ctx.storage.sql.exec(
						"UPDATE api_key_statuses SET key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ?",
						Date.now(),
						apiKey
					);
				} else if (response.status === 429) {
					// Still getting 429, increment failed_count
					const newFailedCount = failedCount + 1;
					if (newFailedCount >= 5) {
						// Delete the key if it has failed 5 times
						await this.ctx.storage.sql.exec('DELETE FROM api_keys WHERE api_key = ?', apiKey);
					} else {
						await this.ctx.storage.sql.exec(
							'UPDATE api_key_statuses SET failed_count = ?, last_checked_at = ? WHERE api_key = ?',
							newFailedCount,
							Date.now(),
							apiKey
						);
					}
				}
			} catch (e) {
				console.error(`Error checking abnormal key ${apiKey}:`, e);
			}
		}

		// 2. Handle normal keys
		const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
		const normalKeys = await this.ctx.storage.sql
			.exec(
				"SELECT api_key FROM api_key_statuses WHERE key_group = 'normal' AND (last_checked_at IS NULL OR last_checked_at < ?)",
				twelveHoursAgo
			)
			.raw<any>();

		for (const row of Array.from(normalKeys)) {
			const apiKey = row[0] as string;
			try {
				const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: 'hi' }] }],
					}),
				});
				if (response.status === 429) {
					// Move to abnormal group
					await this.ctx.storage.sql.exec(
						"UPDATE api_key_statuses SET key_group = 'abnormal', failed_count = 1, last_checked_at = ? WHERE api_key = ?",
						Date.now(),
						apiKey
					);
				} else {
					// Update last_checked_at
					await this.ctx.storage.sql.exec('UPDATE api_key_statuses SET last_checked_at = ? WHERE api_key = ?', Date.now(), apiKey);
				}
			} catch (e) {
				console.error(`Error checking normal key ${apiKey}:`, e);
			}
		}

		// Reschedule the alarm
		this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: fixCors({}).headers,
			});
		}
		const url = new URL(request.url);
		const pathname = url.pathname;

		// 静态资源直接放行
		if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
			return new Response('', { status: 204 });
		}

		// 管理 API 权限校验（使用 HOME_ACCESS_KEY）
		if (pathname === '/api/keys' || pathname === '/api/keys/check' || pathname === '/api/stats') {
			if (!isAdminAuthenticated(request, this.env.HOME_ACCESS_KEY)) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
				});
			}
			if (pathname === '/api/keys' && request.method === 'POST') {
				return this.handleApiKeys(request);
			}
			if (pathname === '/api/keys' && request.method === 'GET') {
				return this.getAllApiKeys(request);
			}
			if (pathname === '/api/keys' && request.method === 'DELETE') {
				return this.handleDeleteApiKeys(request);
			}
			if (pathname === '/api/keys/check' && request.method === 'POST') {
				return this.handleApiKeysCheck(request);
			}
			if (pathname === '/api/stats' && request.method === 'GET') {
				return this.getRequestStats();
			}
		}

		// 速率限制检查
		if (this.env.RATE_LIMIT_ENABLED) {
			const identifier = request.headers.get('CF-Connecting-IP') ?? 'unknown';
			const isLimited = await this.checkRateLimit(identifier);
			if (isLimited) {
				return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }), {
					status: 429,
					headers: fixCors({
						headers: {
							'Content-Type': 'application/json',
							'Retry-After': '60'
						}
					}).headers,
				});
			}
		}


		const search = url.search;

		// OpenAI compatible routes
		if (
			pathname.endsWith('/chat/completions') ||
			pathname.endsWith('/completions') ||
			pathname.endsWith('/embeddings') ||
			pathname.endsWith('/v1/models')
		) {
			return this.handleOpenAI(request);
		}

		// Anthropic/Claude compatible routes
		if (pathname.endsWith('/messages') || pathname.endsWith('/v1/messages')) {
			return this.handleAnthropic(request);
		}


		// Direct Gemini proxy
		const authKey = this.env.AUTH_KEY;

		let targetUrl = `${BASE_URL}${pathname}${search}`;

		if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
			return this.forwardRequestWithLoadBalancing(targetUrl, request);
		}

		// 传统模式：验证 AUTH_KEY
		if (authKey) {
			let isAuthorized = false;
			// Check key in query parameters
			if (search.includes('key=')) {
				const urlObj = new URL(targetUrl);
				const requestKey = urlObj.searchParams.get('key');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				}
			} else {
				// Check x-goog-api-key in headers
				const requestKey = request.headers.get('x-goog-api-key');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				}
			}

			if (!isAuthorized) {
				return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
			}
		}
		// If authKey is not set, or if it was authorized, proceed to forward with load balancing.
		return this.forwardRequestWithLoadBalancing(targetUrl, request);
	}

	async forwardRequest(targetUrl: string, request: Request, headers: Headers, apiKey: string): Promise<Response> {
		console.log(`Request Sending to Gemini: ${targetUrl}`);

		const response = await fetch(targetUrl, {
			method: request.method,
			headers: headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
		});

		if (response.status === 429) {
			console.log(`API key ${apiKey} received 429 status code.`);
			await this.ctx.storage.sql.exec(
				"UPDATE api_key_statuses SET key_group = 'abnormal', failed_count = failed_count + 1, last_checked_at = ? WHERE api_key = ?",
				Date.now(),
				apiKey
			);
		}

		console.log('Call Gemini Success');

		const responseHeaders = new Headers(response.headers);
		responseHeaders.set('Access-Control-Allow-Origin', '*');
		responseHeaders.delete('transfer-encoding');
		responseHeaders.delete('connection');
		responseHeaders.delete('keep-alive');
		responseHeaders.delete('content-encoding');
		responseHeaders.set('Referrer-Policy', 'no-referrer');

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	}

	// 对请求进行负载均衡，随机分发key，支持自动重试
	private async forwardRequestWithLoadBalancing(targetUrl: string, request: Request): Promise<Response> {
		try {
			let headers = new Headers();
			const url = new URL(targetUrl);

			// Forward content-type header
			if (request.headers.has('content-type')) {
				headers.set('content-type', request.headers.get('content-type')!);
			}

			if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
				// 提取客户端的 API key
				const clientApiKey = this.extractClientApiKey(request, url);

				if (clientApiKey) {
					url.searchParams.set('key', clientApiKey);
					headers.set('x-goog-api-key', clientApiKey);
				}

				const startTime = Date.now();
				const response = await this.forwardRequest(url.toString(), request, headers, clientApiKey || '');
				const responseTime = Date.now() - startTime;
				await this.recordRequestStats(clientApiKey || '', url.pathname, responseTime, response.status);
				return response;
			}

			// 自动重试机制
			const maxRetries = typeof this.env.MAX_RETRY_COUNT === 'number' ? this.env.MAX_RETRY_COUNT : 2;
			const usedKeys: Set<string> = new Set();
			let lastResponse: Response | null = null;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				const apiKey = await this.getRandomApiKey(usedKeys);
				if (!apiKey) {
					if (lastResponse) return lastResponse;
					return new Response('No API keys configured in the load balancer.', { status: 500 });
				}

				usedKeys.add(apiKey);
				const requestUrl = new URL(targetUrl);
				requestUrl.searchParams.set('key', apiKey);
				const requestHeaders = new Headers(headers);
				requestHeaders.set('x-goog-api-key', apiKey);

				const startTime = Date.now();
				const response = await this.forwardRequest(requestUrl.toString(), request, requestHeaders, apiKey);
				const responseTime = Date.now() - startTime;

				// 记录统计数据
				await this.recordRequestStats(apiKey, url.pathname, responseTime, response.status);
				await this.updateKeyStats(apiKey, responseTime);

				// 如果成功或非可重试错误，直接返回
				if (response.ok || (response.status !== 429 && response.status < 500)) {
					return response;
				}

				// 可重试错误，记录并继续
				lastResponse = response;
				console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed with status ${response.status} for key ...${apiKey.slice(-6)}`);
			}

			return lastResponse ?? new Response('All retries exhausted', { status: 503 });
		} catch (error) {
			console.error('Failed to fetch:', error);
			return new Response('Internal Server Error\n' + error, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	}

	// 记录请求统计
	private async recordRequestStats(apiKey: string, path: string, responseTimeMs: number, statusCode: number): Promise<void> {
		try {
			// 提取模型名称
			const modelMatch = path.match(/models\/([^/:]+)/);
			const model = modelMatch ? modelMatch[1] : 'unknown';

			await this.ctx.storage.sql.exec(
				`INSERT INTO request_stats (api_key, model, response_time_ms, status_code, created_at) VALUES (?, ?, ?, ?, ?)`,
				apiKey.slice(-8), // 只存储后8位用于识别
				model,
				responseTimeMs,
				statusCode,
				Date.now()
			);

			// 清理7天前的统计数据
			const sevenDaysAgo = Date.now() - (this.env.STATS_RETENTION_DAYS ?? 7) * 24 * 60 * 60 * 1000;
			await this.ctx.storage.sql.exec(`DELETE FROM request_stats WHERE created_at < ?`, sevenDaysAgo);
		} catch (e) {
			console.error('Failed to record request stats:', e);
		}
	}

	// 更新 key 的使用统计
	private async updateKeyStats(apiKey: string, responseTimeMs: number): Promise<void> {
		try {
			// 更新使用计数和平均响应时间（滚动平均）
			await this.ctx.storage.sql.exec(
				`UPDATE api_key_statuses SET 
					usage_count = usage_count + 1,
					response_time_avg = (response_time_avg * usage_count + ?) / (usage_count + 1),
					last_used_at = ?
				WHERE api_key = ?`,
				responseTimeMs,
				Date.now(),
				apiKey
			);
		} catch (e) {
			console.error('Failed to update key stats:', e);
		}
	}

	// 获取请求统计数据
	private async getRequestStats(): Promise<Response> {
		try {
			const now = Date.now();
			const oneDayAgo = now - 24 * 60 * 60 * 1000;
			const oneHourAgo = now - 60 * 60 * 1000;

			// 获取总体统计
			const overallStats = await this.ctx.storage.sql.exec(`
				SELECT 
					COUNT(*) as total_requests,
					SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success_count,
					SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) as rate_limited_count,
					AVG(response_time_ms) as avg_response_time
				FROM request_stats 
				WHERE created_at > ?
			`, oneDayAgo).raw<any>();

			// 获取按模型分组的统计
			const modelStats = await this.ctx.storage.sql.exec(`
				SELECT 
					model,
					COUNT(*) as requests,
					AVG(response_time_ms) as avg_response_time
				FROM request_stats 
				WHERE created_at > ?
				GROUP BY model
				ORDER BY requests DESC
				LIMIT 10
			`, oneDayAgo).raw<any>();

			// 获取最近1小时的请求趋势
			const hourlyTrend = await this.ctx.storage.sql.exec(`
				SELECT 
					(created_at / 300000) * 300000 as time_bucket,
					COUNT(*) as requests
				FROM request_stats 
				WHERE created_at > ?
				GROUP BY time_bucket
				ORDER BY time_bucket ASC
			`, oneHourAgo).raw<any>();

			// 获取 key 使用统计
			const keyStats = await this.ctx.storage.sql.exec(`
				SELECT 
					api_key,
					usage_count,
					response_time_avg,
					key_group,
					last_used_at
				FROM api_key_statuses
				ORDER BY usage_count DESC
				LIMIT 20
			`).raw<any>();

			const overall = Array.from(overallStats)[0] || [0, 0, 0, 0];
			const models = Array.from(modelStats).map((row: any) => ({
				model: row[0],
				requests: row[1],
				avgResponseTime: Math.round(row[2])
			}));
			const trend = Array.from(hourlyTrend).map((row: any) => ({
				time: row[0],
				requests: row[1]
			}));
			const keys = Array.from(keyStats).map((row: any) => ({
				apiKey: row[0],
				usageCount: row[1],
				avgResponseTime: Math.round(row[2]),
				keyGroup: row[3],
				lastUsedAt: row[4]
			}));

			return new Response(JSON.stringify({
				overview: {
					totalRequests: overall[0],
					successCount: overall[1],
					rateLimitedCount: overall[2],
					avgResponseTime: Math.round(overall[3] || 0),
					successRate: overall[0] > 0 ? Math.round((overall[1] / overall[0]) * 100) : 0
				},
				modelStats: models,
				hourlyTrend: trend,
				keyStats: keys
			}), {
				headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
			});
		} catch (error: any) {
			console.error('获取统计数据失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
			});
		}
	}

	// 检查速率限制
	private async checkRateLimit(identifier: string): Promise<boolean> {
		try {
			const limit = this.env.RATE_LIMIT_PER_MINUTE ?? 60;
			const now = Date.now();
			const windowStart = now - 60000; // 1分钟窗口

			// 清理过期记录
			await this.ctx.storage.sql.exec(
				`DELETE FROM rate_limits WHERE window_start < ?`,
				windowStart
			);

			// 获取当前计数
			const result = await this.ctx.storage.sql.exec(
				`SELECT request_count FROM rate_limits WHERE identifier = ?`,
				identifier
			).raw<any>();
			const rows = Array.from(result);

			if (rows.length === 0) {
				// 新用户，创建记录
				await this.ctx.storage.sql.exec(
					`INSERT INTO rate_limits (identifier, request_count, window_start) VALUES (?, 1, ?)`,
					identifier,
					now
				);
				return false;
			}

			const currentCount = rows[0][0] as number;
			if (currentCount >= limit) {
				console.log(`[RateLimit] Identifier ${identifier} exceeded limit (${currentCount}/${limit})`);
				return true;
			}

			// 增加计数
			await this.ctx.storage.sql.exec(
				`UPDATE rate_limits SET request_count = request_count + 1 WHERE identifier = ?`,
				identifier
			);
			return false;
		} catch (error) {
			console.error('Rate limit check failed:', error);
			return false; // 出错时放行
		}
	}

	async handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { models } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: models.map(({ name }: any) => ({
						id: name.replace('models/', ''),
						object: 'model',
						created: 0,
						owned_by: '',
					})),
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleEmbeddings(req: any, apiKey: string) {
		const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-004';

		if (typeof req.model !== 'string') {
			throw new HttpError('model is not specified', 400);
		}

		let model;
		if (req.model.startsWith('models/')) {
			model = req.model;
		} else {
			if (!req.model.startsWith('gemini-')) {
				req.model = DEFAULT_EMBEDDINGS_MODEL;
			}
			model = 'models/' + req.model;
		}

		if (!Array.isArray(req.input)) {
			req.input = [req.input];
		}

		const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				requests: req.input.map((text: string) => ({
					model,
					content: { parts: { text } },
					outputDimensionality: req.dimensions,
				})),
			}),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { embeddings } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: embeddings.map(({ values }: any, index: number) => ({
						object: 'embedding',
						index,
						embedding: values,
					})),
					model: req.model,
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async handleCompletions(req: any, apiKey: string) {
		const DEFAULT_MODEL = 'gemini-2.5-flash';
		let model = DEFAULT_MODEL;

		switch (true) {
			case typeof req.model !== 'string':
				break;
			case req.model.startsWith('models/'):
				model = req.model.substring(7);
				break;
			case req.model.startsWith('gemini-'):
			case req.model.startsWith('gemma-'):
			case req.model.startsWith('learnlm-'):
				model = req.model;
		}

		let body = await this.transformRequest(req);
		const extra = req.extra_body?.google;

		if (extra) {
			if (extra.safety_settings) {
				body.safetySettings = extra.safety_settings;
			}
			if (extra.cached_content) {
				body.cachedContent = extra.cached_content;
			}
			if (extra.thinking_config) {
				body.generationConfig.thinkingConfig = extra.thinking_config;
			}
		}

		switch (true) {
			case model.endsWith(':search'):
				model = model.substring(0, model.length - 7);
			case req.model.endsWith('-search-preview'):
			case req.tools?.some((tool: any) => tool.function?.name === 'googleSearch'):
				body.tools = body.tools || [];
				body.tools.push({ function_declarations: [{ name: 'googleSearch', parameters: {} }] });
		}

		const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		if (req.stream) {
			url += '?alt=sse';
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(body),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			let id = 'chatcmpl-' + this.generateId();
			const shared = {};

			if (req.stream) {
				responseBody = response
					.body!.pipeThrough(new TextDecoderStream())
					.pipeThrough(
						new TransformStream({
							transform: this.parseStream,
							flush: this.parseStreamFlush,
							buffer: '',
							shared,
						} as any)
					)
					.pipeThrough(
						new TransformStream({
							transform: this.toOpenAiStream,
							flush: this.toOpenAiStreamFlush,
							streamIncludeUsage: req.stream_options?.include_usage,
							model,
							id,
							last: [],
							reasoningLast: [],
							shared,
						} as any)
					)
					.pipeThrough(new TextEncoderStream());
			} else {
				let body: any = await response.text();
				try {
					body = JSON.parse(body);
					if (!body.candidates) {
						throw new Error('Invalid completion object');
					}
				} catch (err) {
					console.error('Error parsing response:', err);
					return new Response(JSON.stringify({ error: 'Failed to parse response' }), {
						...fixCors(response),
						status: 500,
					});
				}
				responseBody = this.processCompletionsResponse(body, model, id);
			}
		}
		return new Response(responseBody, fixCors(response));
	}

	// 辅助方法
	private generateId(): string {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
		return Array.from({ length: 29 }, randomChar).join('');
	}

	private async transformRequest(req: any) {
		const harmCategory = [
			'HARM_CATEGORY_HATE_SPEECH',
			'HARM_CATEGORY_SEXUALLY_EXPLICIT',
			'HARM_CATEGORY_DANGEROUS_CONTENT',
			'HARM_CATEGORY_HARASSMENT',
			'HARM_CATEGORY_CIVIC_INTEGRITY',
		];

		const safetySettings = harmCategory.map((category) => ({
			category,
			threshold: 'BLOCK_NONE',
		}));

		return {
			...(await this.transformMessages(req.messages)),
			safetySettings,
			generationConfig: this.transformConfig(req),
			...this.transformTools(req),
			cachedContent: undefined as any,
		};
	}

	private transformConfig(req: any) {
		const fieldsMap: Record<string, string> = {
			frequency_penalty: 'frequencyPenalty',
			max_completion_tokens: 'maxOutputTokens',
			max_tokens: 'maxOutputTokens',
			n: 'candidateCount',
			presence_penalty: 'presencePenalty',
			seed: 'seed',
			stop: 'stopSequences',
			temperature: 'temperature',
			top_k: 'topK',
			top_p: 'topP',
		};

		const thinkingBudgetMap: Record<string, number> = {
			low: 1024,
			medium: 8192,
			high: 24576,
		};

		let cfg: any = {};
		for (let key in req) {
			const matchedKey = fieldsMap[key];
			if (matchedKey) {
				cfg[matchedKey] = req[key];
			}
		}

		if (req.response_format) {
			switch (req.response_format.type) {
				case 'json_schema':
					cfg.responseSchema = req.response_format.json_schema?.schema;
					if (cfg.responseSchema && 'enum' in cfg.responseSchema) {
						cfg.responseMimeType = 'text/x.enum';
						break;
					}
				case 'json_object':
					cfg.responseMimeType = 'application/json';
					break;
				case 'text':
					cfg.responseMimeType = 'text/plain';
					break;
				default:
					throw new HttpError('Unsupported response_format.type', 400);
			}
		}
		if (req.reasoning_effort) {
			cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
		}

		return cfg;
	}

	private async transformMessages(messages: any[]) {
		if (!messages) {
			return {};
		}

		const contents: any[] = [];
		let system_instruction;

		for (const item of messages) {
			switch (item.role) {
				case 'system':
					system_instruction = { parts: await this.transformMsg(item) };
					continue;
				case 'assistant':
					item.role = 'model';
					break;
				case 'user':
					break;
				default:
					throw new HttpError(`Unknown message role: "${item.role}"`, 400);
			}

			if (system_instruction) {
				// 修复：确保 parts 是数组后再调用 some 方法
				if (!contents[0]?.parts || (Array.isArray(contents[0]?.parts) && !contents[0]?.parts.some((part: any) => part.text))) {
					contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
				}
			}

			contents.push({
				role: item.role,
				parts: await this.transformMsg(item),
			});
		}

		return { system_instruction, contents };
	}

	private async transformMsg({ content }: any) {
		const parts = [];
		if (!Array.isArray(content)) {
			parts.push({ text: content });
			return parts;
		}

		for (const item of content) {
			switch (item.type) {
				case 'text':
					parts.push({ text: item.text });
					break;
				case 'image_url':
					parts.push(await this.parseImg(item.image_url.url));
					break;
				case 'input_audio':
					parts.push({
						inlineData: {
							mimeType: 'audio/' + item.input_audio.format,
							data: item.input_audio.data,
						},
					});
					break;
				default:
					throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
			}
		}

		if (content.every((item) => item.type === 'image_url')) {
			parts.push({ text: '' }); // to avoid "Unable to submit request because it must have a text parameter"
		}
		return parts;
	}
	private async parseImg(url: any) {
		let mimeType, data;
		if (url.startsWith('http://') || url.startsWith('https://')) {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText} (${url})`);
				}
				mimeType = response.headers.get('content-type');
				data = Buffer.from(await response.arrayBuffer()).toString('base64');
			} catch (err) {
				throw new Error('Error fetching image: ' + (err as Error).message);
			}
		} else {
			const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
			if (!match) {
				throw new HttpError('Invalid image data: ' + url, 400);
			}
			({ mimeType, data } = match.groups);
		}
		return {
			inlineData: {
				mimeType,
				data,
			},
		};
	}

	private adjustSchema(schema: any) {
		const obj = schema[schema.type];
		delete obj.strict;
		return this.adjustProps(schema);
	}

	private adjustProps(schemaPart: any) {
		if (typeof schemaPart !== 'object' || schemaPart === null) {
			return;
		}
		if (Array.isArray(schemaPart)) {
			schemaPart.forEach(this.adjustProps);
		} else {
			if (schemaPart.type === 'object' && schemaPart.properties && schemaPart.additionalProperties === false) {
				delete schemaPart.additionalProperties;
			}
			Object.values(schemaPart).forEach(this.adjustProps);
		}
	}

	private transformTools(req: any) {
		let tools, tool_config;
		if (req.tools) {
			const funcs = req.tools.filter((tool: any) => tool.type === 'function' && tool.function?.name !== 'googleSearch');
			if (funcs.length > 0) {
				funcs.forEach(this.adjustSchema);
				tools = [{ function_declarations: funcs.map((schema: any) => schema.function) }];
			}
		}
		if (req.tool_choice) {
			const allowed_function_names = req.tool_choice?.type === 'function' ? [req.tool_choice?.function?.name] : undefined;
			if (allowed_function_names || typeof req.tool_choice === 'string') {
				tool_config = {
					function_calling_config: {
						mode: allowed_function_names ? 'ANY' : req.tool_choice.toUpperCase(),
						allowed_function_names,
					},
				};
			}
		}
		return { tools, tool_config };
	}

	private processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const transformCandidatesMessage = (cand: any) => {
			const message = { role: 'assistant', content: [] as string[] };
			let reasoningContent = '';
			let finalContent = '';

			for (const part of cand.content?.parts ?? []) {
				if (part.text) {
					// 检查是否是思考内容
					// Gemini API 可能使用多种方式标识思考内容
					const isThoughtContent =
						part.thoughtToken ||
						part.thought ||
						part.thoughtTokens ||
						(part.executableCode && part.executableCode.language === 'thought') ||
						// 检查文本是否以思考标记开头
						(part.text && (part.text.startsWith('<thinking>') || part.text.startsWith('思考：') || part.text.startsWith('Thinking:')));

					if (isThoughtContent) {
						// 这是思考内容，应该放在 reasoning_content 字段中
						// 如果文本包含思考标记，需要移除这些标记
						let cleanText = part.text;
						if (cleanText.startsWith('<thinking>')) {
							cleanText = cleanText.replace('<thinking>', '').replace('</thinking>', '');
						} else if (cleanText.startsWith('思考：')) {
							cleanText = cleanText.replace('思考：', '');
						} else if (cleanText.startsWith('Thinking:')) {
							cleanText = cleanText.replace('Thinking:', '');
						}
						reasoningContent += cleanText;
					} else {
						// 这是正常的回答内容
						finalContent += part.text;
					}
				}
			}

			const messageObj: any = {
				index: cand.index || 0,
				message: {
					role: 'assistant',
					content: finalContent || null,
				},
				logprobs: null,
				finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
			};

			// 如果有思考内容，添加到响应中
			if (reasoningContent) {
				messageObj.message.reasoning_content = reasoningContent;
			}

			return messageObj;
		};

		const obj = {
			id,
			choices: data.candidates.map(transformCandidatesMessage),
			created: Math.floor(Date.now() / 1000),
			model: data.modelVersion ?? model,
			object: 'chat.completion',
			usage: data.usageMetadata && {
				completion_tokens: data.usageMetadata.candidatesTokenCount,
				prompt_tokens: data.usageMetadata.promptTokenCount,
				total_tokens: data.usageMetadata.totalTokenCount,
			},
		};

		return JSON.stringify(obj);
	}

	// 流处理方法
	private parseStream(this: any, chunk: string, controller: any) {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop()!;

		for (const line of lines) {
			if (line.startsWith('data: ')) {
				const data = line.substring(6);
				if (data.startsWith('{')) {
					controller.enqueue(JSON.parse(data));
				}
			}
		}
	}

	private parseStreamFlush(this: any, controller: any) {
		if (this.buffer) {
			try {
				controller.enqueue(JSON.parse(this.buffer));
				this.shared.is_buffers_rest = true;
			} catch (e) {
				console.error('Error parsing remaining buffer:', e);
			}
		}
	}

	private toOpenAiStream(this: any, line: any, controller: any) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const { candidates, usageMetadata } = line;
		if (usageMetadata) {
			this.shared.usage = {
				completion_tokens: usageMetadata.candidatesTokenCount,
				prompt_tokens: usageMetadata.promptTokenCount,
				total_tokens: usageMetadata.totalTokenCount,
			};
		}

		if (candidates) {
			for (const cand of candidates) {
				const { index, content, finishReason } = cand;
				const { parts } = content;

				// 分别处理思考内容和正常内容
				let reasoningText = '';
				let finalText = '';

				for (const part of parts) {
					if (part.text) {
						// 检查是否是思考内容
						// Gemini API 可能使用多种方式标识思考内容
						const isThoughtContent =
							part.thoughtToken ||
							part.thought ||
							part.thoughtTokens ||
							(part.executableCode && part.executableCode.language === 'thought') ||
							// 检查文本是否以思考标记开头
							(part.text && (part.text.startsWith('<thinking>') || part.text.startsWith('思考：') || part.text.startsWith('Thinking:')));

						if (isThoughtContent) {
							// 这是思考内容
							// 如果文本包含思考标记，需要移除这些标记
							let cleanText = part.text;
							if (cleanText.startsWith('<thinking>')) {
								cleanText = cleanText.replace('<thinking>', '').replace('</thinking>', '');
							} else if (cleanText.startsWith('思考：')) {
								cleanText = cleanText.replace('思考：', '');
							} else if (cleanText.startsWith('Thinking:')) {
								cleanText = cleanText.replace('Thinking:', '');
							}
							reasoningText += cleanText;
						} else {
							// 这是正常的回答内容
							finalText += part.text;
						}
					}
				}

				// 处理思考内容的流式输出
				if (reasoningText) {
					if (!this.reasoningLast) this.reasoningLast = {};
					if (this.reasoningLast[index] === undefined) {
						this.reasoningLast[index] = '';
					}

					const lastReasoningText = this.reasoningLast[index] || '';
					let reasoningDelta = '';

					if (reasoningText.startsWith(lastReasoningText)) {
						reasoningDelta = reasoningText.substring(lastReasoningText.length);
					} else {
						// Find the common prefix
						let i = 0;
						while (i < reasoningText.length && i < lastReasoningText.length && reasoningText[i] === lastReasoningText[i]) {
							i++;
						}
						reasoningDelta = reasoningText.substring(i);
					}

					this.reasoningLast[index] = reasoningText;

					if (reasoningDelta) {
						const reasoningObj = {
							id: this.id,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model: this.model,
							choices: [
								{
									index,
									delta: { reasoning_content: reasoningDelta },
									finish_reason: null,
								},
							],
						};
						controller.enqueue(`data: ${JSON.stringify(reasoningObj)}\n\n`);
					}
				}

				// 处理正常内容的流式输出
				if (finalText) {
					if (this.last[index] === undefined) {
						this.last[index] = '';
					}

					const lastText = this.last[index] || '';
					let delta = '';

					if (finalText.startsWith(lastText)) {
						delta = finalText.substring(lastText.length);
					} else {
						// Find the common prefix
						let i = 0;
						while (i < finalText.length && i < lastText.length && finalText[i] === lastText[i]) {
							i++;
						}
						// Send the rest of the new text as delta.
						// This might not be perfect for all clients, but it prevents data loss.
						delta = finalText.substring(i);
					}

					this.last[index] = finalText;

					if (delta) {
						const obj = {
							id: this.id,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model: this.model,
							choices: [
								{
									index,
									delta: { content: delta },
									finish_reason: null,
								},
							],
						};
						controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
					}
				}

				// 如果有完成原因，发送完成信号
				if (finishReason) {
					const finishObj = {
						id: this.id,
						object: 'chat.completion.chunk',
						created: Math.floor(Date.now() / 1000),
						model: this.model,
						choices: [
							{
								index,
								delta: {},
								finish_reason: reasonsMap[finishReason] || finishReason,
							},
						],
					};
					controller.enqueue(`data: ${JSON.stringify(finishObj)}\n\n`);
				}
			}
		}
	}

	private toOpenAiStreamFlush(this: any, controller: any) {
		if (this.streamIncludeUsage && this.shared.usage) {
			const obj = {
				id: this.id,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: this.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: 'stop',
					},
				],
				usage: this.shared.usage,
			};
			controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
		}
		controller.enqueue('data: [DONE]\n\n');
	}
	// =================================================================================================
	// Admin API Handlers
	// =================================================================================================

	async handleApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			for (const key of keys) {
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_keys (api_key) VALUES (?)', key);
				await this.ctx.storage.sql.exec('INSERT OR IGNORE INTO api_key_statuses (api_key) VALUES (?)', key);
			}

			return new Response(JSON.stringify({ message: 'API密钥添加成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('处理API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleDeleteApiKeys(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const batchSize = 500;
			for (let i = 0; i < keys.length; i += batchSize) {
				const batch = keys.slice(i, i + batchSize);
				const placeholders = batch.map(() => '?').join(',');
				await this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE api_key IN (${placeholders})`, ...batch);
			}

			return new Response(JSON.stringify({ message: 'API密钥删除成功。' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('删除API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async handleApiKeysCheck(request: Request): Promise<Response> {
		try {
			const { keys } = (await request.json()) as { keys: string[] };
			if (!Array.isArray(keys) || keys.length === 0) {
				return new Response(JSON.stringify({ error: '请求体无效，需要一个包含key的非空数组。' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const checkResults = await Promise.all(
				keys.map(async (key) => {
					try {
						const response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${key}`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								contents: [{ parts: [{ text: 'hi' }] }],
							}),
						});
						return { key, valid: response.ok, error: response.ok ? null : await response.text() };
					} catch (e: any) {
						return { key, valid: false, error: e.message };
					}
				})
			);

			for (const result of checkResults) {
				if (result.valid) {
					await this.ctx.storage.sql.exec(
						"UPDATE api_key_statuses SET status = 'normal', key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ?",
						Date.now(),
						result.key
					);
				} else {
					await this.ctx.storage.sql.exec('DELETE FROM api_keys WHERE api_key = ?', result.key);
				}
			}

			return new Response(JSON.stringify(checkResults), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('检查API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	async getAllApiKeys(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const page = parseInt(url.searchParams.get('page') || '1', 10);
			const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10);
			const offset = (page - 1) * pageSize;

			const totalResult = await this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM api_key_statuses').raw<any>();
			const totalArray = Array.from(totalResult);
			const total = totalArray.length > 0 ? totalArray[0][0] : 0;

			const results = await this.ctx.storage.sql
				.exec('SELECT api_key, status, key_group, last_checked_at, failed_count FROM api_key_statuses LIMIT ? OFFSET ?', pageSize, offset)
				.raw<any>();
			const keys = results
				? Array.from(results).map((row: any) => ({
					api_key: row[0],
					status: row[1],
					key_group: row[2],
					last_checked_at: row[3],
					failed_count: row[4],
				}))
				: [];

			return new Response(JSON.stringify({ keys, total }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			console.error('获取API密钥失败:', error);
			return new Response(JSON.stringify({ error: error.message || '内部服务器错误' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// =================================================================================================
	// Helper Methods
	// =================================================================================================

	/**
	 * 从请求中提取客户端的 API key
	 * 支持多种传递方式：查询参数、x-goog-api-key header、Authorization header
	 */
	private extractClientApiKey(request: Request, url: URL): string | null {
		// 从查询参数中提取
		if (url.searchParams.has('key')) {
			const key = url.searchParams.get('key');
			if (key) return key;
		}

		// 从 x-goog-api-key header 中提取
		const googApiKey = request.headers.get('x-goog-api-key');
		if (googApiKey) return googApiKey;

		// 从 Authorization header 中提取 (Bearer token)
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			return authHeader.substring(7);
		}

		return null;
	}

	private async getRandomApiKey(excludeKeys?: Set<string>): Promise<string | null> {
		try {
			const strategy = this.env.LOAD_BALANCE_STRATEGY ?? 'random';
			const excludeArray = excludeKeys ? Array.from(excludeKeys) : [];
			const excludePlaceholders = excludeArray.length > 0
				? `AND api_key NOT IN (${excludeArray.map(() => '?').join(',')})`
				: '';

			// 根据策略选择排序方式
			let orderBy: string;
			switch (strategy) {
				case 'least-used':
					orderBy = 'ORDER BY usage_count ASC, RANDOM()';
					break;
				case 'fastest':
					orderBy = 'ORDER BY response_time_avg ASC, RANDOM()';
					break;
				default: // 'random'
					orderBy = 'ORDER BY RANDOM()';
			}

			// First, try to get a key from the normal group
			const normalQuery = `SELECT api_key FROM api_key_statuses WHERE key_group = 'normal' ${excludePlaceholders} ${orderBy} LIMIT 1`;
			let results = await this.ctx.storage.sql
				.exec(normalQuery, ...excludeArray)
				.raw<any>();
			let keys = Array.from(results);
			if (keys && keys.length > 0) {
				const key = keys[0][0] as string;
				console.log(`[LoadBalance] Selected API Key from normal group (${strategy}): ...${key.slice(-6)}`);
				return key;
			}

			// If no keys in normal group, try the abnormal group
			const abnormalQuery = `SELECT api_key FROM api_key_statuses WHERE key_group = 'abnormal' ${excludePlaceholders} ${orderBy} LIMIT 1`;
			results = await this.ctx.storage.sql
				.exec(abnormalQuery, ...excludeArray)
				.raw<any>();
			keys = Array.from(results);
			if (keys && keys.length > 0) {
				const key = keys[0][0] as string;
				console.log(`[LoadBalance] Selected API Key from abnormal group (${strategy}): ...${key.slice(-6)}`);
				return key;
			}

			return null;
		} catch (error) {
			console.error('获取随机API密钥失败:', error);
			return null;
		}
	}


	private async handleOpenAI(request: Request): Promise<Response> {
		const authKey = this.env.AUTH_KEY;
		let apiKey: string | null;

		const authHeader = request.headers.get('Authorization');
		apiKey = authHeader?.replace('Bearer ', '') ?? null;

		// 如果启用了客户端 key 透传，直接使用客户端提供的 key
		if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
			if (!apiKey) {
				return new Response('No API key found in the client headers,please check your request!', { status: 400 });
			}
			// 直接使用客户端的 API key，不需要验证
		} else {
			// 传统模式：验证 AUTH_KEY 并使用负载均衡
			if (!apiKey) {
				return new Response('No API key found in the client headers,please check your request!', { status: 400 });
			}

			if (authKey) {
				const token = authHeader?.replace('Bearer ', '');
				if (token !== authKey) {
					return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
				}
				apiKey = await this.getRandomApiKey();
				if (!apiKey) {
					return new Response('No API keys configured in the load balancer.', { status: 500 });
				}
			}
		}

		const url = new URL(request.url);
		const pathname = url.pathname;

		const assert = (success: Boolean) => {
			if (!success) {
				throw new HttpError('The specified HTTP method is not allowed for the requested resource', 400);
			}
		};
		const errHandler = (err: Error) => {
			console.error(err);
			return new Response(err.message, fixCors({ statusText: err.message ?? 'Internal Server Error', status: 500 }));
		};

		switch (true) {
			case pathname.endsWith('/chat/completions'):
				assert(request.method === 'POST');
				return this.handleCompletions(await request.json(), apiKey).catch(errHandler);
			case pathname.endsWith('/embeddings'):
				assert(request.method === 'POST');
				return this.handleEmbeddings(await request.json(), apiKey).catch(errHandler);
			case pathname.endsWith('/models'):
				assert(request.method === 'GET');
				return this.handleModels(apiKey).catch(errHandler);
			default:
				throw new HttpError('404 Not Found', 404);
		}
	}

	// ========================================
	// Anthropic/Claude API Compatibility
	// ========================================

	private async handleAnthropic(request: Request): Promise<Response> {
		const authKey = this.env.AUTH_KEY;
		let apiKey: string | null;

		// Claude uses x-api-key header or Authorization header
		const xApiKey = request.headers.get('x-api-key');
		const authHeader = request.headers.get('Authorization');
		const clientKey = xApiKey || authHeader?.replace('Bearer ', '') || null;

		if (this.env.FORWARD_CLIENT_KEY_ENABLED) {
			if (!clientKey) {
				return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'No API key provided' } }), {
					status: 401,
					headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
				});
			}
			apiKey = clientKey;
		} else {
			if (authKey && clientKey !== authKey) {
				return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }), {
					status: 401,
					headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
				});
			}
			apiKey = await this.getRandomApiKey();
			if (!apiKey) {
				return new Response(JSON.stringify({ error: { type: 'api_error', message: 'No API keys configured' } }), {
					status: 500,
					headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
				});
			}
		}

		try {
			const req = await request.json() as any;
			return this.handleAnthropicMessages(req, apiKey);
		} catch (err: any) {
			console.error('Anthropic handler error:', err);
			return new Response(JSON.stringify({ error: { type: 'api_error', message: err.message } }), {
				status: 500,
				headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
			});
		}
	}

	private async handleAnthropicMessages(req: any, apiKey: string): Promise<Response> {
		// Map Claude model to Gemini model
		const modelMap: Record<string, string> = {
			'claude-3-opus': 'gemini-2.5-pro',
			'claude-3-sonnet': 'gemini-2.5-flash',
			'claude-3-haiku': 'gemini-2.0-flash',
			'claude-3-5-sonnet': 'gemini-2.5-flash',
			'claude-3-5-haiku': 'gemini-2.0-flash',
		};

		let model = 'gemini-2.5-flash';
		if (req.model) {
			// Check for direct mapping
			for (const [claudeModel, geminiModel] of Object.entries(modelMap)) {
				if (req.model.includes(claudeModel)) {
					model = geminiModel;
					break;
				}
			}
			// If model starts with gemini-, use it directly
			if (req.model.startsWith('gemini-')) {
				model = req.model;
			}
		}

		// Convert Claude messages to Gemini format
		const contents: any[] = [];
		let systemInstruction: any = undefined;

		// Handle system prompt
		if (req.system) {
			systemInstruction = {
				parts: [{ text: typeof req.system === 'string' ? req.system : req.system.map((s: any) => s.text).join('\n') }]
			};
		}

		// Convert messages
		for (const msg of req.messages || []) {
			const role = msg.role === 'assistant' ? 'model' : 'user';
			const parts: any[] = [];

			if (typeof msg.content === 'string') {
				parts.push({ text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === 'text') {
						parts.push({ text: block.text });
					} else if (block.type === 'image') {
						// Handle base64 image
						if (block.source?.type === 'base64') {
							parts.push({
								inlineData: {
									mimeType: block.source.media_type,
									data: block.source.data
								}
							});
						}
					}
				}
			}

			if (parts.length > 0) {
				contents.push({ role, parts });
			}
		}

		// Build Gemini request body
		const geminiBody: any = {
			contents,
			generationConfig: {
				maxOutputTokens: req.max_tokens || 4096,
				temperature: req.temperature,
				topP: req.top_p,
				topK: req.top_k,
				stopSequences: req.stop_sequences,
			}
		};

		if (systemInstruction) {
			geminiBody.systemInstruction = systemInstruction;
		}

		const isStream = req.stream === true;
		const TASK = isStream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		if (isStream) {
			url += '?alt=sse';
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(geminiBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return new Response(JSON.stringify({
				error: { type: 'api_error', message: errorText }
			}), {
				status: response.status,
				headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
			});
		}

		const messageId = 'msg_' + this.generateId();

		if (isStream) {
			// Stream response in Claude format
			const transformStream = new TransformStream({
				buffer: '',
				inputTokens: 0,
				outputTokens: 0,
				async transform(chunk: string, controller: TransformStreamDefaultController) {
					const self = this as any;
					self.buffer += chunk;
					const lines = self.buffer.split('\n');
					self.buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const data = line.slice(6);
						if (data === '[DONE]') {
							// Send final message_stop event
							controller.enqueue(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
							return;
						}
						try {
							const parsed = JSON.parse(data);
							if (parsed.candidates?.[0]?.content?.parts) {
								for (const part of parsed.candidates[0].content.parts) {
									if (part.text) {
										self.outputTokens += Math.ceil(part.text.length / 4);
										controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify({
											type: 'content_block_delta',
											index: 0,
											delta: { type: 'text_delta', text: part.text }
										})}\n\n`);
									}
								}
							}
							if (parsed.usageMetadata) {
								self.inputTokens = parsed.usageMetadata.promptTokenCount || 0;
								self.outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
							}
						} catch (e) {
							// Skip invalid JSON
						}
					}
				},
				flush(controller: TransformStreamDefaultController) {
					const self = this as any;
					// Send message_delta with usage
					controller.enqueue(`event: message_delta\ndata: ${JSON.stringify({
						type: 'message_delta',
						delta: { stop_reason: 'end_turn', stop_sequence: null },
						usage: { output_tokens: self.outputTokens }
					})}\n\n`);
				}
			} as any);

			// Send initial events
			const encoder = new TextEncoder();
			const initialEvents = [
				`event: message_start\ndata: ${JSON.stringify({
					type: 'message_start',
					message: {
						id: messageId,
						type: 'message',
						role: 'assistant',
						content: [],
						model: req.model || model,
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 0, output_tokens: 0 }
					}
				})}\n\n`,
				`event: content_block_start\ndata: ${JSON.stringify({
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'text', text: '' }
				})}\n\n`
			];

			const responseStream = response.body!
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(transformStream)
				.pipeThrough(new TextEncoderStream());

			// Prepend initial events
			const reader = responseStream.getReader();
			const outputStream = new ReadableStream({
				async start(controller) {
					for (const event of initialEvents) {
						controller.enqueue(encoder.encode(event));
					}
				},
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
					} else {
						controller.enqueue(value);
					}
				}
			});

			return new Response(outputStream, {
				headers: fixCors({
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'Connection': 'keep-alive'
					}
				}).headers,
			});
		} else {
			// Non-streaming response
			const geminiResponse = await response.json() as any;
			const textContent = geminiResponse.candidates?.[0]?.content?.parts
				?.filter((p: any) => p.text)
				?.map((p: any) => p.text)
				?.join('') || '';

			const anthropicResponse = {
				id: messageId,
				type: 'message',
				role: 'assistant',
				content: [{ type: 'text', text: textContent }],
				model: req.model || model,
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: {
					input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
					output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
				}
			};

			return new Response(JSON.stringify(anthropicResponse), {
				headers: fixCors({ headers: { 'Content-Type': 'application/json' } }).headers,
			});
		}
	}
}
