import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BridgeHttpServer } from './mcpServer';

// All discovery state lives in the extension's globalStorage — VS Code's own
// per-extension storage on the machine running this extension host (for SSH
// Remote that is `~/.vscode-server/data/User/globalStorage/<ext-id>/`, exactly
// where Claude Code/Codex run). The stdio bridge knows this layout and scans
// the well-known globalStorage roots when no env hint is available.
let instancesDir: string;
let instanceFile: string;
let tokenFile: string;
let bridgeScriptFile: string;

/** Name of the env var injected into this window's integrated terminals. */
const INSTANCE_ENV_VAR = 'VSCODE_BROWSER_BRIDGE_INSTANCE';

let server: BridgeHttpServer | undefined;
let currentToken: string | undefined;
let statusBar: vscode.StatusBarItem;
let log: vscode.LogOutputChannel;

/**
 * A key for this window that is stable across reloads, derived from the
 * workspace identity. The instance file path therefore stays valid in
 * terminal environments even when the extension host restarts on a new port.
 */
function windowKey(): string {
	const identity = vscode.workspace.workspaceFile?.toString()
		?? (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()).join('|');
	if (!identity) {
		return `empty-${process.pid}`; // empty windows have no stable identity
	}
	return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

function initPaths(context: vscode.ExtensionContext): void {
	const storageDir = context.globalStorageUri.fsPath;
	instancesDir = path.join(storageDir, 'instances');
	tokenFile = path.join(storageDir, 'token');
	bridgeScriptFile = path.join(storageDir, 'stdio-bridge.mjs');
	instanceFile = path.join(instancesDir, `${windowKey()}.json`);
}

/**
 * Copy the stdio bridge to a version-independent path in globalStorage.
 * Installed extension folders are versioned (.../theozhao.vscode-browser-bridge-x.y.z/),
 * so agent configs pointing into them break on every upgrade. This copy is
 * refreshed on each activation and its path never changes. Atomic rename so a
 * concurrently starting agent never reads a half-written file.
 */
function publishStdioBridge(context: vscode.ExtensionContext): void {
	try {
		fs.mkdirSync(path.dirname(bridgeScriptFile), { recursive: true, mode: 0o700 });
		const tmp = `${bridgeScriptFile}.${process.pid}.tmp`;
		fs.copyFileSync(context.asAbsolutePath(path.join('bin', 'stdio-bridge.mjs')), tmp);
		fs.renameSync(tmp, bridgeScriptFile);
	} catch (err) {
		log.warn(`Could not publish the stdio bridge to globalStorage: ${err}`);
	}
}

/** Token survives VS Code restarts so agent configs keep working. */
function loadOrCreateToken(): string {
	fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
	try {
		const existing = fs.readFileSync(tokenFile, 'utf8').trim();
		if (existing) {
			return existing;
		}
	} catch { /* create below */ }
	const token = crypto.randomBytes(24).toString('hex');
	fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
	return token;
}

function writeInstanceFile(url: string, token: string | undefined): void {
	fs.mkdirSync(instancesDir, { recursive: true, mode: 0o700 });
	const payload = {
		url,
		token,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		// All folders of this window; the bridge matches them against the
		// agent's cwd so each agent reaches the window managing its project.
		workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
	};
	fs.writeFileSync(instanceFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
}

function removeInstanceFile(): void {
	try {
		fs.unlinkSync(instanceFile);
	} catch { /* already gone */ }
}

/** Remove instance files left behind by extension hosts that died without deactivating. */
function sweepStaleInstances(): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(instancesDir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const file = path.join(instancesDir, entry);
		if (file === instanceFile) {
			continue;
		}
		try {
			const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
			if (typeof pid === 'number') {
				process.kill(pid, 0); // signal 0: liveness probe only
			}
		} catch {
			try {
				fs.unlinkSync(file);
				log.info(`Swept stale instance file ${entry}`);
			} catch { /* concurrent sweep */ }
		}
	}
}

/** One-time migration away from the pre-0.2 ~/.vscode-browser-bridge dotdir. */
function migrateLegacyDiscoveryDir(): void {
	const legacyDir = path.join(os.homedir(), '.vscode-browser-bridge');
	try {
		if (!fs.existsSync(legacyDir)) {
			return;
		}
		const legacyToken = path.join(legacyDir, 'token');
		if (!fs.existsSync(tokenFile) && fs.existsSync(legacyToken)) {
			fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
			fs.copyFileSync(legacyToken, tokenFile);
		}
		fs.rmSync(legacyDir, { recursive: true, force: true });
		log.info(`Migrated and removed legacy discovery dir ${legacyDir}`);
	} catch (err) {
		log.warn(`Legacy discovery dir migration failed: ${err}`);
	}
}

async function startServer(): Promise<void> {
	if (server?.status) {
		return;
	}
	const config = vscode.workspace.getConfiguration('browserBridge');
	const token = config.get<boolean>('requireAuth', true) ? loadOrCreateToken() : undefined;
	currentToken = token;
	server = new BridgeHttpServer(token, log);
	try {
		const status = await server.start(config.get<number>('port', 7345));
		sweepStaleInstances();
		writeInstanceFile(status.url, token);
		statusBar.text = `$(globe) Browser MCP :${status.port}`;
		statusBar.tooltip = `Browser Bridge MCP server at ${status.url}\nClick for connection info`;
		statusBar.show();
		if (status.toolCount === 0) {
			log.warn('No integrated-browser tools found in vscode.lm.tools. ' +
				'Check that the setting "workbench.browser.enableChatTools" is enabled ' +
				'and that this VS Code version ships the integrated browser (>= 1.110).');
		}
	} catch (err) {
		server = undefined;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`Failed to start: ${message}`);
		void vscode.window.showErrorMessage(`Browser Bridge failed to start: ${message}`);
	}
}

async function stopServer(): Promise<void> {
	removeInstanceFile();
	statusBar.hide();
	if (server) {
		await server.stop();
		server = undefined;
	}
}

function showStatus(): void {
	const status = server?.status;
	if (!status) {
		void vscode.window.showInformationMessage(
			'Browser Bridge MCP server is not running.', 'Start',
		).then(pick => pick === 'Start' && vscode.commands.executeCommand('browserBridge.start'));
		return;
	}
	const browserToolsAvailable = status.toolCount > 0 ||
		vscode.lm.tools.some(t => t.name === 'open_browser_page');
	// Prefer the version-independent copy in globalStorage; the bundled file
	// only serves as a fallback if publishing failed.
	const stdioBridge = fs.existsSync(bridgeScriptFile)
		? bridgeScriptFile
		: path.join(__dirname, '..', 'bin', 'stdio-bridge.mjs');
	const items: (vscode.QuickPickItem & { copy?: string })[] = [
		{
			label: '$(plug) Endpoint',
			detail: status.url,
			description: browserToolsAvailable ? 'browser tools available' : '⚠ browser tools NOT detected',
			copy: status.url,
		},
		{
			label: '$(terminal) Claude Code setup command',
			detail: `claude mcp add vscode-browser -- node ${stdioBridge}`,
			copy: `claude mcp add vscode-browser -- node ${stdioBridge}`,
		},
		{
			label: '$(terminal) Codex setup (~/.codex/config.toml)',
			detail: `[mcp_servers.vscode_browser] command = "node", args = ["${stdioBridge}"], env_vars = [...]`,
			// Codex sanitizes the MCP server environment; env_vars forwards the
			// per-window routing hint from Codex's own environment.
			copy: `[mcp_servers.vscode_browser]\ncommand = "node"\nargs = ["${stdioBridge}"]\nenv_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]`,
		},
		{
			// Generic stdio config for any other MCP client (Claude Desktop,
			// Cline, ...). The instance file of *this* window is pinned in env,
			// so the client reaches the window you clicked regardless of how it
			// is launched or whether it inherits the terminal environment.
			label: '$(json) Generic MCP client (stdio JSON)',
			detail: 'Standard mcpServers JSON, routed to this window',
			copy: JSON.stringify({
				mcpServers: {
					'vscode-browser': {
						command: 'node',
						args: [stdioBridge],
						env: { [INSTANCE_ENV_VAR]: instanceFile },
					},
				},
			}, null, 2),
		},
		{
			// Direct streamable-HTTP config — the only item that exposes the
			// bearer token. The port can change on reload, so this is best for
			// short-lived use; the stdio bridge re-resolves automatically.
			label: '$(globe) Direct HTTP (url + token)',
			detail: status.url,
			copy: JSON.stringify({
				mcpServers: {
					'vscode-browser': {
						type: 'http',
						url: status.url,
						...(currentToken ? { headers: { Authorization: `Bearer ${currentToken}` } } : {}),
					},
				},
			}, null, 2),
		},
	];
	void vscode.window.showQuickPick(items, { title: 'Browser Bridge MCP' }).then(pick => {
		if (pick?.copy) {
			void vscode.env.clipboard.writeText(pick.copy);
			void vscode.window.showInformationMessage('Copied to clipboard.');
		}
	});
}

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('Browser Bridge', { log: true });
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	statusBar.command = 'browserBridge.showStatus';
	context.subscriptions.push(log, statusBar);

	initPaths(context);
	migrateLegacyDiscoveryDir();
	publishStdioBridge(context);

	// Inject the instance file path into this window's integrated terminals
	// (the same mechanism the Git extension uses for VSCODE_GIT_IPC_HANDLE).
	// Agents started from a terminal inherit it and reach exactly this window;
	// the path is reload-stable, only the file's contents change.
	context.environmentVariableCollection.description = 'Browser Bridge endpoint discovery';
	context.environmentVariableCollection.replace(INSTANCE_ENV_VAR, instanceFile);

	context.subscriptions.push(
		vscode.commands.registerCommand('browserBridge.start', startServer),
		vscode.commands.registerCommand('browserBridge.stop', stopServer),
		vscode.commands.registerCommand('browserBridge.showStatus', showStatus),
		// Keep the instance file's folder list current so cwd matching works
		// after folders are added to or removed from the window.
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			if (server?.status) {
				writeInstanceFile(server.status.url, currentToken);
			}
		}),
	);

	if (vscode.workspace.getConfiguration('browserBridge').get<boolean>('autoStart', true)) {
		void startServer();
	}
}

export function deactivate(): Promise<void> {
	return stopServer();
}
