import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The built-in integrated-browser tools registered by VS Code core
 * (src/vs/workbench/contrib/browserView). `vscode.lm.tools[].name` equals the
 * internal tool id, and `vscode.lm.invokeTool` accepts that id directly.
 */
export const BROWSER_TOOL_IDS = [
	'open_browser_page',
	'read_page',
	'screenshot_page',
	'navigate_page',
	'click_element',
	'type_in_page',
	'hover_element',
	'drag_element',
	'handle_dialog',
	'run_playwright_code',
] as const;

const SERVER_INSTRUCTIONS = `Tools for driving the browser integrated in the user's VS Code window.

Workflow:
1. Call 'open_browser_page' first, always with a URL — calling it without one is a
   no-op through this bridge (the page picker only works inside Copilot chat).
   Its result contains the pageId of the shared page. The user confirms a dialog in
   VS Code — if the call is cancelled, the user declined.
2. Pass that pageId to the other tools (read_page, click_element, screenshot_page, ...).
3. Pages must be in the "shared" state; if a tool reports the page is not shared,
   ask the user to share it via the browser tab's sharing button in VS Code.

Each 'open_browser_page' and URL navigation ('navigate_page' with a url), and every
'run_playwright_code' call, shows a confirmation dialog the user must accept. Reading
and interacting with an already-shared page (read/screenshot/click/type/hover/drag,
reload/back/forward) needs no confirmation — prefer working within shared pages over
repeatedly opening new ones.

The browser runs inside the user's VS Code client. When VS Code is connected over SSH,
localhost URLs from this machine are reachable through VS Code port forwarding, so
'open_browser_page' with a local dev-server URL generally just works.

To save a screenshot as a file on this machine, use 'save_page_screenshot' — the image
bytes are written directly to disk by the bridge and never enter the conversation.`;

export interface BridgeStatus {
	url: string;
	port: number;
	toolCount: number;
}

function listBrowserTools(): readonly vscode.LanguageModelToolInformation[] {
	const ids = new Set<string>(BROWSER_TOOL_IDS);
	return vscode.lm.tools.filter(t => ids.has(t.name));
}

/**
 * Bridge-only tool: runs 'screenshot_page' and writes the resulting image to
 * disk in the extension-host process (the same machine the agents run on),
 * so image bytes never pass through the model as base64 text.
 */
const SAVE_SCREENSHOT_TOOL = {
	name: 'save_page_screenshot',
	description:
		'Take a screenshot of a shared browser page (like screenshot_page) but save it ' +
		'to a file on this machine instead of returning the image inline. Returns the ' +
		'absolute file path. Use this to keep screenshots for reports, diffs, or commits.',
	inputSchema: {
		type: 'object',
		properties: {
			pageId: { type: 'string', description: 'The browser page ID, acquired from open_browser_page.' },
			selector: { type: 'string', description: 'Optional CSS selector to capture a single element instead of the viewport.' },
			ref: { type: 'string', description: 'Optional aria-ref of an element from read_page, alternative to selector.' },
			scrollIntoViewIfNeeded: { type: 'boolean', description: 'Scroll the element into view before capturing.' },
			path: {
				type: 'string',
				description: 'Destination file path. Relative paths resolve against the workspace root. ' +
					'Defaults to .tmp/browser-shots/<pageId>-<timestamp>.<ext> in the workspace. ' +
					'The file extension is corrected to match the actual image format.',
			},
		},
		required: ['pageId'],
	},
} as const;

function extractImagePart(result: vscode.LanguageModelToolResult): { data: Uint8Array; mimeType: string } | undefined {
	const DataPart = (vscode as any).LanguageModelDataPart;
	if (!DataPart) {
		return undefined;
	}
	for (const part of result.content) {
		if (part instanceof DataPart) {
			const p = part as { mimeType: string; data: Uint8Array };
			if (p.mimeType.startsWith('image/')) {
				return p;
			}
		}
	}
	return undefined;
}

async function saveScreenshot(args: Record<string, unknown>, token: vscode.CancellationToken): Promise<CallToolResult> {
	const { path: requestedPath, ...screenshotArgs } = args;
	const result = await vscode.lm.invokeTool(
		'screenshot_page',
		{ input: screenshotArgs, toolInvocationToken: undefined },
		token,
	);

	const image = extractImagePart(result);
	if (!image) {
		// No image part means screenshot_page reported an error (e.g. unknown
		// pageId, page not shared) — relay its text result as-is.
		return { isError: true, content: toMcpContent(result) };
	}

	const ext = image.mimeType === 'image/png' ? '.png' : image.mimeType === 'image/jpeg' ? '.jpg' : '';
	const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
	const pageId = String(screenshotArgs.pageId ?? 'page').replace(/[^\w-]/g, '_');
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	let target = typeof requestedPath === 'string' && requestedPath.length > 0
		? path.resolve(baseDir, requestedPath)
		: path.join(baseDir, '.tmp', 'browser-shots', `${pageId}-${timestamp}${ext}`);
	if (ext && !target.toLowerCase().endsWith(ext) && !(ext === '.jpg' && target.toLowerCase().endsWith('.jpeg'))) {
		target += ext;
	}

	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, image.data);
	return {
		content: [{
			type: 'text',
			text: `Saved screenshot to ${target} (${image.mimeType}, ${image.data.byteLength} bytes)`,
		}],
	};
}

/** Convert a LanguageModelToolResult into MCP tool-result content blocks. */
function toMcpContent(result: vscode.LanguageModelToolResult): CallToolResult['content'] {
	const content: CallToolResult['content'] = [];
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			content.push({ type: 'text', text: part.value });
			continue;
		}
		// LanguageModelDataPart carries binary results such as screenshots.
		// Feature-detect: it may not exist on older VS Code versions.
		const DataPart = (vscode as any).LanguageModelDataPart;
		if (DataPart && part instanceof DataPart) {
			const p = part as { mimeType: string; data: Uint8Array };
			if (p.mimeType.startsWith('image/')) {
				content.push({ type: 'image', data: Buffer.from(p.data).toString('base64'), mimeType: p.mimeType });
			} else {
				content.push({ type: 'text', text: `[binary ${p.mimeType}, ${p.data.byteLength} bytes]` });
			}
			continue;
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			content.push({ type: 'text', text: JSON.stringify(part.value) });
			continue;
		}
		content.push({ type: 'text', text: String((part as any)?.value ?? '') });
	}
	if (content.length === 0) {
		content.push({ type: 'text', text: '(empty result)' });
	}
	return content;
}

function buildMcpServer(): Server {
	const server = new Server(
		{ name: 'vscode-browser-bridge', version: '0.2.7' },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const mirrored = listBrowserTools();
		const tools = mirrored.map(t => ({
			name: t.name,
			description: t.description,
			inputSchema: (t.inputSchema as object | undefined) ?? { type: 'object' },
		}));
		if (mirrored.some(t => t.name === 'screenshot_page')) {
			tools.push({ ...SAVE_SCREENSHOT_TOOL, inputSchema: SAVE_SCREENSHOT_TOOL.inputSchema as object });
		}
		return { tools };
	});

	server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
		const { name, arguments: args } = req.params;
		const isSaveScreenshot = name === SAVE_SCREENSHOT_TOOL.name;
		const requiredBuiltinTool = isSaveScreenshot ? 'screenshot_page' : name;
		if (!isSaveScreenshot && !(BROWSER_TOOL_IDS as readonly string[]).includes(name)) {
			return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
		}
		if (!listBrowserTools().some(t => t.name === requiredBuiltinTool)) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: `Tool '${name}' is not available in VS Code right now. ` +
						`Make sure the integrated browser chat tools are enabled ` +
						`(setting 'workbench.browser.enableChatTools').`,
				}],
			};
		}

		const cts = new vscode.CancellationTokenSource();
		const onAbort = () => cts.cancel();
		extra.signal.addEventListener('abort', onAbort);
		try {
			if (isSaveScreenshot) {
				return await saveScreenshot(args ?? {}, cts.token);
			}
			const result = await vscode.lm.invokeTool(
				name,
				{ input: args ?? {}, toolInvocationToken: undefined },
				cts.token,
			);
			return { content: toMcpContent(result) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const cancelled = err instanceof vscode.CancellationError || /cancel/i.test(message);
			return {
				isError: true,
				content: [{
					type: 'text',
					text: cancelled
						? 'The action was cancelled — the user likely declined the confirmation in VS Code.'
						: `Tool invocation failed: ${message}`,
				}],
			};
		} finally {
			extra.signal.removeEventListener('abort', onAbort);
			cts.dispose();
		}
	});

	return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => {
			if (chunks.length === 0) {
				return resolve(undefined);
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

export class BridgeHttpServer {
	private httpServer: http.Server | undefined;
	public status: BridgeStatus | undefined;

	constructor(
		private readonly token: string | undefined,
		private readonly log: vscode.LogOutputChannel,
	) { }

	/** Start on preferredPort, falling back to an OS-assigned free port. */
	async start(preferredPort: number): Promise<BridgeStatus> {
		const server = http.createServer((req, res) => void this.handle(req, res));
		this.httpServer = server;

		const listen = (port: number) => new Promise<number>((resolve, reject) => {
			const onError = (err: NodeJS.ErrnoException) => reject(err);
			server.once('error', onError);
			server.listen(port, '127.0.0.1', () => {
				server.removeListener('error', onError);
				resolve((server.address() as { port: number }).port);
			});
		});

		let port: number;
		try {
			port = await listen(preferredPort);
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code !== 'EADDRINUSE') {
				throw err;
			}
			this.log.warn(`Port ${preferredPort} in use, falling back to a free port`);
			port = await listen(0);
		}

		this.status = { url: `http://127.0.0.1:${port}/mcp`, port, toolCount: listBrowserTools().length };
		this.log.info(`MCP server listening at ${this.status.url}`);
		return this.status;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/health') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, tools: listBrowserTools().map(t => t.name) }));
				return;
			}
			if (url.pathname !== '/mcp') {
				res.writeHead(404).end();
				return;
			}
			if (this.token) {
				const auth = req.headers.authorization ?? '';
				if (auth !== `Bearer ${this.token}`) {
					res.writeHead(401, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'unauthorized' }));
					return;
				}
			}
			if (req.method !== 'POST') {
				// Stateless mode: no SSE stream, no sessions to delete.
				res.writeHead(405, { allow: 'POST' }).end();
				return;
			}

			const body = await readBody(req);
			// Stateless transport: a fresh server+transport pair per request keeps
			// concurrent agents (Claude Code, Codex, ...) fully isolated.
			const mcp = buildMcpServer();
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			res.on('close', () => {
				void transport.close();
				void mcp.close();
			});
			await mcp.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			this.log.error(`Request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
			if (!res.headersSent) {
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'internal error' }));
			} else {
				res.end();
			}
		}
	}

	async stop(): Promise<void> {
		const server = this.httpServer;
		this.httpServer = undefined;
		this.status = undefined;
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}
}
