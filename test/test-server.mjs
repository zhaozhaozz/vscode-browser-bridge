// Mock of the extension-side HTTP MCP server, for testing bin/stdio-bridge.mjs
// without VS Code. Mirrors mcpServer.ts: stateless transport, bearer auth.
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOKEN = 'test-token-123';

function buildServer() {
	const s = new Server({ name: 'mock-bridge', version: '0.0.1' }, { capabilities: { tools: {} } });
	s.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [{
			name: 'open_browser_page',
			description: `mock open on :${PORT}`,
			inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
		}],
	}));
	s.setRequestHandler(CallToolRequestSchema, async req => ({
		content: [{ type: 'text', text: `opened ${req.params.arguments?.url} (pageId: page-1)` }],
	}));
	return s;
}

const httpServer = http.createServer(async (req, res) => {
	if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
		res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
	const mcp = buildServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	res.on('close', () => { transport.close(); mcp.close(); });
	await mcp.connect(transport);
	await transport.handleRequest(req, res, body);
});

const PORT = Number(process.argv[2] ?? 7399);
httpServer.listen(PORT, '127.0.0.1', () => console.error(`mock server on :${PORT}`));
