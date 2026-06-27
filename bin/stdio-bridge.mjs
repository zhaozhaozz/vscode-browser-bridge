#!/usr/bin/env node
// Zero-dependency stdio→HTTP proxy for the VS Code Browser Bridge extension.
//
// MCP clients that only speak stdio (or where configuring HTTP headers is
// inconvenient) run this script; it forwards each JSON-RPC message to the
// extension's streamable-HTTP endpoint and writes responses back to stdout.
//
// Endpoint resolution order:
//   --url/--token args or VSCODE_BROWSER_BRIDGE_URL/_TOKEN env (pinned)
//   > VSCODE_BROWSER_BRIDGE_INSTANCE env (per-window file, set by the extension
//     in integrated terminals) > cwd match against instance files in the
//     extension's globalStorage > newest live instance

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

function argValue(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

// A reloaded VS Code window restarts the extension host, which may come back on
// a different port. Stay within this window when re-resolving the endpoint
// after a failed request, so long-running agent sessions survive the reload.
const RECOVERY_WINDOW_MS = 15_000;
const RECOVERY_RETRY_DELAY_MS = 1_000;

const pinnedUrl = argValue('--url') ?? process.env.VSCODE_BROWSER_BRIDGE_URL;
const pinnedToken = argValue('--token') ?? process.env.VSCODE_BROWSER_BRIDGE_TOKEN;
// Injected by the extension into each window's integrated terminals: the path
// of that window's instance file. Reload-stable; only the contents change.
// MCP clients that sanitize the server environment must forward it explicitly
// (Codex CLI: env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"] in config.toml).
const instanceFileFromEnv = process.env.VSCODE_BROWSER_BRIDGE_INSTANCE;
// Discovery scanning is opt-in: agents not started from a VS Code integrated
// terminal (no env hint) get an idle bridge with zero tools instead of being
// routed to some arbitrary window — unless --discover or --workspace is given.
const workspaceArg = argValue('--workspace') ?? process.env.VSCODE_BROWSER_BRIDGE_WORKSPACE;
const discoveryAllowed = process.argv.includes('--discover') || !!workspaceArg;
// The directory used to pick the matching VS Code window when scanning.
// Agents spawn MCP servers with cwd set to the project directory, so cwd is
// the right default.
const matchDir = resolve(workspaceArg ?? process.cwd());

// The extension stores instance files in its globalStorage:
// <data-root>/User/globalStorage/<ext-id>/instances/. VS Code lowercases the
// extension id (<publisher>.<name>) for the on-disk folder.
const EXTENSION_STORAGE_ID = 'theozhao.vscode-browser-bridge';
function candidateInstanceDirs() {
	const home = homedir();
	const linuxConfig = flavor => join(home, '.config', flavor);
	const macConfig = flavor => join(home, 'Library', 'Application Support', flavor);
	const roots = [
		join(home, '.vscode-server', 'data'),
		join(home, '.vscode-server-insiders', 'data'),
		...['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium', 'Cursor'].flatMap(f => [linuxConfig(f), macConfig(f)]),
		...(process.env.APPDATA ? [join(process.env.APPDATA, 'Code'), join(process.env.APPDATA, 'Code - Insiders')] : []),
	];
	return roots.map(r => join(r, 'User', 'globalStorage', EXTENSION_STORAGE_ID, 'instances'));
}

function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function toEndpoint(info) {
	return info?.url ? { url: info.url, token: pinnedToken ?? info.token } : undefined;
}

/**
 * Resolution order:
 * 1. The instance file named by VSCODE_BROWSER_BRIDGE_INSTANCE — set by the
 *    extension in integrated terminals, pointing at exactly this window.
 * 2. Scan all VS Code globalStorage roots for live instances and pick the
 *    window whose workspace folder contains matchDir (longest folder wins;
 *    ties go to the most recently started window).
 * 3. The most recently started live instance.
 * Returns undefined when nothing is reachable.
 */
function resolveEndpoint() {
	if (instanceFileFromEnv) {
		const info = readJson(instanceFileFromEnv);
		if (info?.url && (!info.pid || isPidAlive(info.pid))) {
			return toEndpoint(info);
		}
		// Window gone or mid-reload: fall through (scanning only if allowed).
	}
	if (!discoveryAllowed) {
		return undefined;
	}

	const instances = candidateInstanceDirs().flatMap(dir => {
		try {
			return readdirSync(dir).map(f => readJson(join(dir, f)));
		} catch {
			return [];
		}
	}).filter(i => i?.url && (!i.pid || isPidAlive(i.pid)));

	let best;
	let bestFolderLength = -1;
	for (const inst of instances) {
		for (const folder of inst.workspaceFolders ?? []) {
			const normalized = resolve(folder);
			const contains = matchDir === normalized || matchDir.startsWith(normalized + sep);
			if (contains && (normalized.length > bestFolderLength ||
				(normalized.length === bestFolderLength && (inst.startedAt ?? '') > (best?.startedAt ?? '')))) {
				best = inst;
				bestFolderLength = normalized.length;
			}
		}
	}
	// No window owns this directory — fall back to the newest live instance.
	best ??= instances.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
	return toEndpoint(best);
}

let endpoint;
if (pinnedUrl) {
	endpoint = { url: pinnedUrl, token: pinnedToken };
} else {
	endpoint = resolveEndpoint();
	if (!endpoint) {
		// Idle mode: stay up and answer the MCP handshake with zero tools.
		// Each request retries resolution, so the bridge attaches by itself
		// once a matching VS Code window appears.
		process.stderr.write(
			'vscode-browser-bridge: idle — ' +
			(instanceFileFromEnv || discoveryAllowed
				? 'no running VS Code window found yet.'
				: 'not started from a VS Code integrated terminal (pass --discover, --workspace or --url to attach from outside).') +
			'\n');
	}
}

const IDLE_INSTRUCTIONS =
	'VS Code Browser Bridge is idle: this agent was not started from a VS Code ' +
	'integrated terminal and no window is attached, so no browser tools are ' +
	'available. Start the agent from a terminal inside VS Code (or pass ' +
	'--discover/--workspace/--url to the bridge) to control the integrated browser.';

/** Minimal local MCP handling while no VS Code window is attached. */
function handleIdle(message) {
	if (message.id === undefined) {
		return; // notifications need no reply
	}
	const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
	switch (message.method) {
		case 'initialize':
			reply({
				protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'vscode-browser-bridge', version: '0.2.9' },
				instructions: IDLE_INSTRUCTIONS,
			});
			break;
		case 'tools/list':
			reply({ tools: [] });
			break;
		case 'ping':
			reply({});
			break;
		default:
			send({
				jsonrpc: '2.0', id: message.id,
				error: { code: -32601, message: `Browser Bridge is idle, '${message.method}' is unavailable. ${IDLE_INSTRUCTIONS}` },
			});
	}
}

function headers() {
	return {
		'content-type': 'application/json',
		// Streamable HTTP servers require both accept types even in JSON mode.
		'accept': 'application/json, text/event-stream',
		...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
	};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * POST to the current endpoint; on connection failure, re-run endpoint
 * resolution (instance files are rewritten on every extension restart) and
 * retry until the recovery window closes. Pinned --url/env endpoints are
 * never switched.
 */
async function fetchWithRecovery(body) {
	const deadline = Date.now() + RECOVERY_WINDOW_MS;
	for (; ;) {
		try {
			return await fetch(endpoint.url, { method: 'POST', headers: headers(), body });
		} catch (err) {
			if (pinnedUrl || Date.now() >= deadline) {
				throw err;
			}
		}
		await sleep(RECOVERY_RETRY_DELAY_MS);
		const fresh = resolveEndpoint();
		if (fresh) {
			endpoint = fresh;
		}
	}
}

/** Extract JSON-RPC messages from an SSE body (fallback if server streams). */
function parseSse(text) {
	return text.split('\n')
		.filter(line => line.startsWith('data:'))
		.map(line => JSON.parse(line.slice(5).trim()));
}

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

async function forward(message) {
	if (!endpoint) {
		endpoint = resolveEndpoint(); // lazy attach once a window appears
		if (!endpoint) {
			handleIdle(message);
			return;
		}
	}
	const isNotification = message.id === undefined;
	let res;
	try {
		res = await fetchWithRecovery(JSON.stringify(message));
	} catch (err) {
		if (!isNotification) {
			send({
				jsonrpc: '2.0', id: message.id,
				error: { code: -32603, message: `Browser Bridge unreachable at ${endpoint.url}: ${err.message}. Is VS Code (with the Browser Bridge extension) running?` },
			});
		}
		return;
	}
	if (isNotification) {
		return; // 202 Accepted, no body expected
	}
	if (!res.ok) {
		send({
			jsonrpc: '2.0', id: message.id,
			error: { code: -32603, message: `Browser Bridge returned HTTP ${res.status}${res.status === 401 ? ' (bad or missing token — restart this MCP connection to pick up the current token)' : ''}` },
		});
		return;
	}
	const text = await res.text();
	const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
		? parseSse(text)
		: [JSON.parse(text)];
	for (const m of messages) {
		send(m);
	}
}

let pending = 0;
let stdinClosed = false;

function maybeExit() {
	if (stdinClosed && pending === 0) {
		process.exit(0);
	}
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
	line = line.trim();
	if (!line) {
		return;
	}
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stderr.write(`vscode-browser-bridge: skipping non-JSON input line\n`);
		return;
	}
	pending++;
	void forward(message).finally(() => {
		pending--;
		maybeExit();
	});
});
// Exit only after in-flight requests drain, so late responses aren't dropped.
rl.on('close', () => {
	stdinClosed = true;
	maybeExit();
});
