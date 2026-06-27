import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jsonc from 'jsonc-parser';
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
 * A key identifying THIS window: stable across reloads, yet distinct for every
 * concurrently open window — even when several windows have the same folder
 * open. It is derived from `context.storageUri`, the per-window workspace-storage
 * path VS Code assigns (…/workspaceStorage/<id>[-N]/…) and keeps for the window's
 * lifetime, reloads included.
 *
 * Keying on the workspace identity instead made every window on the same folder
 * compute one shared instance file: closing or reloading any of them deleted that
 * file out from under the still-running others, leaving a live server with no
 * discoverable instance file (and terminals pointing at a path that no longer
 * exists). See removeInstanceFile / writeInstanceFile.
 */
function windowKey(context: vscode.ExtensionContext): string {
	const perWindow = context.storageUri?.fsPath;
	if (!perWindow) {
		return `empty-${process.pid}`; // empty window: no workspace storage
	}
	return crypto.createHash('sha256').update(perWindow).digest('hex').slice(0, 12);
}

function initPaths(context: vscode.ExtensionContext): void {
	const storageDir = context.globalStorageUri.fsPath;
	instancesDir = path.join(storageDir, 'instances');
	tokenFile = path.join(storageDir, 'token');
	bridgeScriptFile = path.join(storageDir, 'stdio-bridge.mjs');
	instanceFile = path.join(instancesDir, `${windowKey(context)}.json`);
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
	// Atomic write (tmp + rename): a concurrent window's sweepStaleInstances()
	// must never catch a half-written file, fail to parse it, and delete it as
	// if it were stale.
	const tmp = `${instanceFile}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, instanceFile);
}

function removeInstanceFile(): void {
	try {
		// Delete only if the file still describes THIS host. On reload the old and
		// new extension host briefly overlap on the same instance path; without
		// this guard the departing old host would delete the file the new host
		// just wrote, idling a perfectly live server.
		const onDisk = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
		if (onDisk?.pid !== process.pid) {
			return;
		}
	} catch {
		return; // missing or unreadable — nothing of ours to remove
	}
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
		if (!entry.endsWith('.json')) {
			continue; // skip the *.tmp of a concurrent atomic write
		}
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

/**
 * Add the bridge to opencode's config, preferring an existing opencode.jsonc
 * over opencode.json (opencode reads either). jsonc-parser tolerates comments
 * and trailing commas and edits in place, so a hand-maintained .jsonc keeps its
 * comments and formatting. Returns the file written; throws WITHOUT writing if
 * an existing file can't be parsed, so we never clobber a config we don't grok.
 */
function writeOpencodeConfig(stdioBridge: string): string {
	const dir = path.join(os.homedir(), '.config', 'opencode');
	const jsoncFile = path.join(dir, 'opencode.jsonc');
	const target = fs.existsSync(jsoncFile) ? jsoncFile : path.join(dir, 'opencode.json');

	let text = '';
	try {
		text = fs.readFileSync(target, 'utf8');
	} catch { /* new file — start from scratch below */ }

	if (text.trim()) {
		const errors: jsonc.ParseError[] = [];
		jsonc.parse(text, errors, { allowTrailingComma: true });
		if (errors.length) {
			throw new Error(`could not parse ${target}`);
		}
	}

	const value = { type: 'local', command: ['node', stdioBridge], enabled: true };
	const opts: jsonc.ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
	let edited = text.trim() ? text : '{}';
	if (jsonc.parse(edited).$schema === undefined) {
		edited = jsonc.applyEdits(edited, jsonc.modify(edited, ['$schema'], 'https://opencode.ai/config.json', opts));
	}
	edited = jsonc.applyEdits(edited, jsonc.modify(edited, ['mcp', 'vscode-browser'], value, opts));

	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(target, edited);
	return target;
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
	// "Auto-configure" produces the same portable config as "Copy": the agent
	// forwards VSCODE_BROWSER_BRIDGE_INSTANCE from its own (terminal-injected)
	// environment to the bridge at run time, so the config is not tied to one
	// window — run the agent from a VS Code terminal and it reaches that window.
	const codexCfg = path.join(os.homedir(), '.codex', 'config.toml');
	// Codex strips the MCP server environment, so it needs env_vars to forward
	// the routing hint. `codex mcp add` can only write a literal `env` value,
	// never env_vars, so auto-config removes any old entry (cleanly, subtables
	// included) and appends the correct block. The leading newline keeps it
	// separate from prior content; `;` (not `&&`) runs the append even when
	// there was nothing to remove.
	const codexAppend = `codex mcp remove vscode_browser >/dev/null 2>&1; ` +
		`printf '\\n[mcp_servers.vscode_browser]\\ncommand = "node"\\nargs = ["${stdioBridge}"]\\n` +
		`env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]\\n' >> "${codexCfg}"`;

	type ConfigItem = vscode.QuickPickItem & {
		copy?: string;                       // snippet copied by "Copy" / a raw value copied directly
		instructions?: string;               // shown in the dialog; its presence switches a row to dialog mode
		autoCmd?: string;                    // command run in a terminal by "Auto-configure"
		autoAction?: () => Promise<void>;    // in-process "Auto-configure" (e.g. a comment-preserving file edit)
	};
	const items: ConfigItem[] = [
		{
			label: '$(plug) Endpoint',
			detail: status.url,
			description: browserToolsAvailable ? 'browser tools available' : '⚠ browser tools NOT detected',
			copy: status.url,
		},
		{
			label: '$(terminal) Claude Code',
			detail: 'Register via `claude mcp add`',
			instructions: 'Register the bridge with Claude Code.\n\n' +
				'• Auto-configure: runs `claude mcp add` in a new terminal.\n' +
				'• Copy: copies the command so you can run or edit it yourself.\n\n' +
				'Run Claude Code from a terminal inside VS Code so it forwards the routing hint to the bridge.',
			autoCmd: `claude mcp add -s user vscode-browser -- node "${stdioBridge}"`,
			copy: `claude mcp add -s user vscode-browser -- node ${stdioBridge}`,
		},
		{
			label: '$(terminal) Codex',
			detail: 'Add to ~/.codex/config.toml',
			instructions: 'Add the bridge as an MCP server in ~/.codex/config.toml.\n\n' +
				'• Auto-configure: writes the entry in a new terminal (replaces any existing one).\n' +
				'• Copy: copies the TOML block to paste in yourself.\n\n' +
				'Run Codex from a terminal inside VS Code so it forwards the routing hint to the bridge.',
			// `codex mcp add` can only write a literal env value, never env_vars,
			// so auto-config edits config.toml directly (see codexAppend above).
			autoCmd: codexAppend,
			copy: `[mcp_servers.vscode_browser]\ncommand = "node"\nargs = ["${stdioBridge}"]\nenv_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]`,
		},
		{
			label: '$(terminal) opencode',
			detail: 'Add to opencode.jsonc / .json',
			instructions: 'Add the bridge to opencode (opencode.jsonc if it exists, otherwise opencode.json, ' +
				'under ~/.config/opencode/).\n\n' +
				'• Auto-configure: adds the entry to the file directly — existing comments are kept.\n' +
				'• Copy: copies the JSON to add under "mcp" yourself.\n\n' +
				'Run opencode from a terminal inside VS Code so it forwards the routing hint to the bridge.',
			autoAction: async () => {
				try {
					const target = writeOpencodeConfig(stdioBridge);
					const open = await vscode.window.showInformationMessage(`Added Browser Bridge to ${target}.`, 'Open');
					if (open === 'Open') {
						await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(target)));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void vscode.window.showErrorMessage(`Could not update opencode config: ${message}. Use Copy and edit it by hand.`);
				}
			},
			copy: JSON.stringify({
				$schema: 'https://opencode.ai/config.json',
				mcp: {
					'vscode-browser': {
						type: 'local',
						command: ['node', stdioBridge],
						enabled: true,
					},
				},
			}, null, 2),
		},
		{
			// Generic stdio config for any other MCP client (Claude Desktop,
			// Cline, ...). The instance file of *this* window is pinned in env,
			// so the client reaches the window you clicked regardless of how it
			// is launched or whether it inherits the terminal environment.
			label: '$(json) Generic MCP client (stdio JSON)',
			detail: 'Standard mcpServers JSON, routed to this window',
			instructions: 'Standard stdio mcpServers JSON for any MCP client (Claude Desktop, Cline, ...).\n\n' +
				`It pins this VS Code window via ${INSTANCE_ENV_VAR}, so the client routes here however it is launched.\n\n` +
				"• Copy: copies the JSON to add to the client's config.",
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
			instructions: 'Direct streamable-HTTP config — the only option that exposes the bearer token.\n\n' +
				'The port can change on reload, so prefer the stdio options for long-lived configs.\n\n' +
				"• Copy: copies the JSON to add to the client's config.",
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

	const copyToClipboard = (text: string): void => {
		void vscode.env.clipboard.writeText(text);
		void vscode.window.showInformationMessage('Copied to clipboard.');
	};

	void vscode.window.showQuickPick(items, { title: 'Browser Bridge MCP' }).then(async pick => {
		if (!pick) {
			return;
		}
		// Raw values (the endpoint URL) have no instructions — copy them directly.
		if (!pick.instructions) {
			if (pick.copy) {
				copyToClipboard(pick.copy);
			}
			return;
		}
		const AUTO = 'Auto-configure';
		const COPY = 'Copy';
		const canAuto = Boolean(pick.autoCmd || pick.autoAction);
		const buttons = [...(canAuto ? [AUTO] : []), ...(pick.copy ? [COPY] : [])];
		const title = pick.label.replace(/^\$\([^)]*\)\s*/, '');
		const choice = await vscode.window.showInformationMessage(
			title, { modal: true, detail: pick.instructions }, ...buttons,
		);
		if (choice === AUTO) {
			if (pick.autoAction) {
				await pick.autoAction();
			} else if (pick.autoCmd) {
				const terminal = vscode.window.createTerminal('Browser Bridge setup');
				terminal.show();
				terminal.sendText(pick.autoCmd);
			}
		} else if (choice === COPY && pick.copy) {
			copyToClipboard(pick.copy);
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
