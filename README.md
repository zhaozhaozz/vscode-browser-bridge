# Browser Bridge (MCP)

Expose VS Code's **integrated browser** tools (the ones Copilot agent mode uses) to any
external agent — Claude Code, Codex CLI, or any MCP client. Works with a local VS Code
window, and equally with a Remote-SSH window where the agents run on the remote server.

## How it works

VS Code registers its integrated-browser tools (`open_browser_page`, `click_element`,
`read_page`, `screenshot_page`, `run_playwright_code`, ...) in the workbench's internal
language-model tool service. The stable extension API `vscode.lm.tools` /
`vscode.lm.invokeTool` exposes those tools to extensions.

This extension starts a small MCP server (streamable HTTP, bound to `127.0.0.1`) inside
the extension host and mirrors the browser tools through it. The agent, the bridge, and
the extension host always live on the **same machine** — the one running the extension
host — so they reach each other over `127.0.0.1`:

```
Claude Code / Codex  ──stdio──▶  bin/stdio-bridge.mjs  ──HTTP/127.0.0.1──▶  extension host
                                                                                  │ vscode.lm.invokeTool
                                                                                  ▼
                                                                    VS Code workbench
                                                                    └─ integrated browser (Playwright,
                                                                       visible as a browser tab)
```

- **Local VS Code** — the base case. The extension host, the bridge, the agent, and the
  browser are all on your machine; `vscode.lm.invokeTool` runs in-process.
- **Remote-SSH** — the extension is declared `extensionKind: ["workspace", "ui"]`, so it
  runs in the **remote** extension host. The MCP endpoint and the discovery files then
  live on the remote machine, exactly where your terminal agents run, and the
  `vscode.lm.invokeTool` call is proxied by VS Code back to the local workbench where the
  browser actually renders. Dev servers on the remote machine are reachable in that
  browser through VS Code's port forwarding.

## Requirements

- VS Code **1.110+** (desktop) with the integrated browser available.
- Setting **`workbench.browser.enableChatTools`** enabled (check the chat tools picker
  under *Built-in → browser*).

## Setup

1. Install the `.vsix`. For a Remote-SSH setup install it on the remote (where the
   agents run): `code --install-extension vscode-browser-bridge-0.2.7.vsix`
2. Reload VS Code. A `$(globe) Browser MCP :7345` item appears in the status bar.
   Each window registers its endpoint, token, and workspace folders in the
   extension's **globalStorage** (VS Code's own per-extension storage) — nothing is
   written into your workspaces or as extra home-dir dotfiles. The globalStorage root
   depends on where the extension host runs:

   | Setup | globalStorage root |
   | --- | --- |
   | Remote-SSH | `~/.vscode-server/data/User/globalStorage/theozhao.vscode-browser-bridge/` |
   | Local, Linux | `~/.config/Code/User/globalStorage/theozhao.vscode-browser-bridge/` |
   | Local, macOS | `~/Library/Application Support/Code/User/globalStorage/theozhao.vscode-browser-bridge/` |
   | Local, Windows | `%APPDATA%\Code\User\globalStorage\theozhao.vscode-browser-bridge\` |

   The window also injects `VSCODE_BROWSER_BRIDGE_INSTANCE=<instance file>` into its
   integrated terminals (the same mechanism Git uses for `VSCODE_GIT_IPC_HANDLE`), so
   agents started from a terminal reach exactly the window they were launched from.
3. Register the MCP server with your agent (run on the machine where the agent runs —
   for SSH that is the remote server). Use the **version-independent bridge path**
   `<globalStorage root>/stdio-bridge.mjs` from the table above — the extension
   refreshes that copy on every activation, so upgrading the `.vsix` never breaks
   agent configs (installed extension folders like
   `.../theozhao.vscode-browser-bridge-0.2.7/` are versioned and disappear on upgrade).

   The easiest way is the command **Browser Bridge: Show Status** (also opened by
   clicking the status-bar item). It lists copyable, ready-to-paste configs with
   the path already resolved for your machine (local or remote): the Claude Code
   and Codex commands, a generic stdio `mcpServers` JSON (pinned to that window),
   and a direct HTTP JSON with the URL and bearer token. The examples below use
   the Remote-SSH path:

   **Claude Code**

   ```bash
   claude mcp add vscode-browser -- node ~/.vscode-server/data/User/globalStorage/theozhao.vscode-browser-bridge/stdio-bridge.mjs
   ```

   **Codex CLI** (`~/.codex/config.toml`)

   ```toml
   [mcp_servers.vscode_browser]
   command = "node"
   args = ["/home/<user>/.vscode-server/data/User/globalStorage/theozhao.vscode-browser-bridge/stdio-bridge.mjs"]
   # Codex sanitizes the MCP server environment; forward the routing hint:
   env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]
   ```

   **Any other MCP client**

   The bridge is a standard MCP server, so any client works. Pick whichever
   transport the client supports:

   - **stdio** (most clients — Claude Desktop, Cline, Continue, ...). Run the
     bridge with `node` and point at the version-independent path. The canonical
     JSON config shape is:

     ```json
     {
       "mcpServers": {
         "vscode-browser": {
           "command": "node",
           "args": ["/abs/path/to/globalStorage/theozhao.vscode-browser-bridge/stdio-bridge.mjs"]
         }
       }
     }
     ```

     Routing to the right window relies on `VSCODE_BROWSER_BRIDGE_INSTANCE`.
     Launch the client from a VS Code integrated terminal and most clients pass
     that variable through automatically. If a client starts elsewhere or strips
     the environment, either forward that one variable (e.g. an `"env"` entry in
     the config, or the client's equivalent of Codex's `env_vars`), or pin the
     target explicitly with bridge args: `--url <endpoint>`/`--token <token>`,
     or `--workspace <dir>`/`--discover` to scan and match by directory.

   - **streamable HTTP** (clients that speak it natively). Skip the stdio bridge
     and connect straight to the endpoint, authenticating with the bearer token:

     ```json
     {
       "mcpServers": {
         "vscode-browser": {
           "type": "http",
           "url": "http://127.0.0.1:7345/mcp",
           "headers": { "Authorization": "Bearer <token>" }
         }
       }
     }
     ```

     Read the live `url` and `token` from the window's instance file
     `<globalStorage root>/instances/<key>.json` (or copy them from *Browser
     Bridge: Show Status*). The port can change when a window reloads, so for
     long-lived configs the stdio bridge is preferable — it re-resolves the
     endpoint by itself, whereas a hard-coded HTTP URL must be updated by hand.

## Agent workflow

1. `open_browser_page` with a URL → opens a tab in VS Code's integrated browser. The
   user confirms the sharing dialog once; the result contains the `pageId`.
2. All other tools take that `pageId`: `read_page`, `screenshot_page`, `click_element`,
   `type_in_page`, `navigate_page`, `hover_element`, `drag_element`, `handle_dialog`,
   `run_playwright_code` (arbitrary Playwright code against the shared page).
   The bridge adds one extra tool: `save_page_screenshot` writes the screenshot to a
   file on the agent's machine (default `.tmp/browser-shots/` in the workspace) and
   returns the path — image bytes go straight to disk instead of through the model,
   so agents can keep screenshots for reports or diffs.
3. The user can revoke access anytime with the tab's sharing button — VS Code's
   explicit-sharing security model stays fully in effect.

## Confirmation dialogs

The dialogs are shown by VS Code core (`LanguageModelToolsService`), not by this
extension — the extension cannot suppress or answer them. Without a chat context they
appear as plain modal dialogs in the local VS Code window, with no "Always Allow"
option, so by default they fire on **every** call of:

| Tool call | Dialog |
| --- | --- |
| `open_browser_page` with a URL | "Open Browser Page?" — even when an already-shared page ends up being reused |
| `navigate_page` to a URL | "Navigate Browser?" — `reload`/`back`/`forward` never prompt |
| `run_playwright_code` | "Run Playwright Code?" — shows the full code for review |

Everything else (`read_page`, `screenshot_page`, `save_page_screenshot`,
`click_element`, `type_in_page`, `hover_element`, `drag_element`, `handle_dialog`)
runs without confirmation on a shared page — sharing itself is the authorization.

### Skipping the dialogs

VS Code's `chat.tools.global.autoApprove` setting also applies to tool calls made
through this bridge (verified). Use the per-tool map form and keep
`run_playwright_code` interactive — its dialog is what lets you review arbitrary code
before it runs:

```jsonc
// User settings (settings.json)
"chat.tools.global.autoApprove": {
  "open_browser_page": true,
  "navigate_page": true
}
```

Notes:

- Map keys are tool **ids** (`open_browser_page`), not reference names
  (`openBrowserPage`).
- The first auto-approved call triggers a one-time opt-in warning dialog; enterprise
  policy can disable global auto-approval entirely.
- `chat.tools.eligibleForAutoApproval` works in the opposite direction: set a tool
  (by reference name, e.g. `"runPlaywrightCode": false`) to force a confirmation
  always and hide any auto-approve options.
- `chat.tools.urls.autoApprove` does **not** apply here — it only covers the web
  fetch tool, not browser navigation.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `browserBridge.autoStart` | `true` | Start the MCP server on startup |
| `browserBridge.port` | `7345` | Preferred port (falls back to a free port) |
| `browserBridge.requireAuth` | `true` | Require the bearer token from the instance file |

## Troubleshooting

- **`tools/list` is empty / tool not available** — enable
  `workbench.browser.enableChatTools`; confirm your VS Code is ≥ 1.110 desktop.
- **401 from the bridge** — the agent cached an old token; restart the agent's MCP
  connection (e.g. `/mcp` reconnect in Claude Code) to pick up the current one.
- **Bridge unreachable after a VS Code window reload** — the extension host restarts
  and may come back on a different port. The instance file path stays the same
  (its name derives from the workspace identity, not the process), the bridge
  re-resolves and retries for ~15 s on connection failures, so running agent
  sessions survive a reload; only calls made while VS Code is fully closed fail.
- **Bridge unreachable persistently** — VS Code window closed, or the extension
  stopped. Check the *Browser Bridge* output channel.
- **Several VS Code windows** — each window registers its own instance file, and
  terminals carry `VSCODE_BROWSER_BRIDGE_INSTANCE` pointing at their window's file,
  so windows A and B can be driven concurrently by their own agents. Browser tabs
  and confirmation dialogs always appear in the window the agent is connected to.
- **Agents outside a VS Code terminal get no browser tools — by design.** Without
  the terminal env hint the bridge stays in idle mode: the MCP handshake succeeds
  with an empty tool list, and it attaches automatically on a later call once a
  hint becomes resolvable. To drive a window from outside (plain ssh, cron, ...),
  opt in explicitly: `--discover` scans all VS Code globalStorage roots and picks
  the window whose workspace folders contain the agent's cwd (longest match wins,
  then the most recently started window); `--workspace <dir>` (or
  `VSCODE_BROWSER_BRIDGE_WORKSPACE`) matches for that directory instead; or pin a
  fixed endpoint with `--url`/`--token`.
- **Codex shows `Tools: (none)` even inside a VS Code terminal** — Codex CLI
  spawns MCP servers with a sanitized environment, which strips
  `VSCODE_BROWSER_BRIDGE_INSTANCE`. Add
  `env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]` to the server's table in
  `~/.codex/config.toml` (see Setup above) — Codex then forwards the variable
  from its own environment, so the idle-outside-VS-Code behavior is preserved.
  (`Auth: Unsupported` in Codex's MCP list is harmless: it just means the
  server does not implement OAuth, which stdio servers never do.)
