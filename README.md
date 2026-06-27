# Browser Bridge (MCP)

**Let Claude Code, Codex, and other terminal agents drive the browser built into VS Code.**

VS Code ships an integrated browser with a set of agent tools — open a page, click,
type, screenshot, run Playwright — but out of the box only Copilot can use them. This
extension exposes those same tools over [MCP](https://modelcontextprotocol.io), so any
MCP agent running on your machine can open a real browser tab inside VS Code and
interact with it.

For example, tell your agent *"open localhost:3000 and check the login form works"* — it
opens a tab in VS Code, clicks through the form, and reads the page back, without leaving
your editor. Works with a local VS Code window or over Remote-SSH (the browser renders on
your laptop while the agent and dev server live on the remote).

## Quick start

**Requirements:** VS Code **1.110+** with the setting **`workbench.browser.enableChatTools`**
enabled (find it in the chat tools picker under *Built-in → browser*).

### 1. Install the extension

Open the Extensions view (`Ctrl/Cmd+Shift+X`), search for **Browser Bridge (MCP)**, and
click **Install**. On a Remote-SSH window, install it **on the remote** (the Install
button offers "Install in SSH: …"). Reload VS Code — a **`Browser MCP :<port>`** item
appears in the status bar.

<details><summary>Other ways to install</summary>

- CLI: `code --install-extension theozhao.vscode-browser-bridge`
- From a `.vsix` on the [Releases page](https://github.com/zhaozhaozz/vscode-browser-bridge/releases):
  `code --install-extension vscode-browser-bridge-0.2.9.vsix` (for Remote-SSH, run this on
  the remote).

</details>

### 2. Connect your agent

Click the status-bar item, choose **Show Status**, and pick your agent. Then either
**Auto-configure** — it runs the setup command in a terminal for you — or **Copy** the
ready-to-paste config. Both have the bridge path filled in for your machine. To set it up
by hand instead, the snippets are:

**Claude Code**

```bash
claude mcp add -s user vscode-browser -- node <bridge>
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.vscode_browser]
command = "node"
args = ["<bridge>"]
env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]
```

**opencode** (`opencode.json` in the project root, or `~/.config/opencode/opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vscode-browser": {
      "type": "local",
      "command": ["node", "<bridge>"],
      "enabled": true
    }
  }
}
```

**Any other MCP client** — the standard stdio `mcpServers` form (Claude Desktop, Cline,
Continue, ...):

```json
{
  "mcpServers": {
    "vscode-browser": {
      "command": "node",
      "args": ["<bridge>"]
    }
  }
}
```

`<bridge>` is the path `<globalStorage>/theozhao.vscode-browser-bridge/stdio-bridge.mjs`
(the *Show Status* command fills in the exact path; see
[Where things live](#where-things-live) for the globalStorage location). For HTTP clients
or routing options, see [Connecting any MCP client](#connecting-any-mcp-client).

> **Run the agent from a terminal *inside* VS Code.** That is how the bridge knows which
> window to drive. Agents started elsewhere get no browser tools by default — see
> [Routing & multiple windows](#routing--multiple-windows).

### 3. Use it

Ask your agent to open a URL. It calls `open_browser_page`, you approve the one-time
sharing prompt, and a browser tab opens in VS Code. From there the agent can read, click,
type, screenshot, and run Playwright against that tab.

## What the agent can do

`open_browser_page` opens a URL and returns a `pageId`. Every other tool takes that
`pageId` and acts on the shared tab:

| Tool | What it does |
| --- | --- |
| `open_browser_page` | Open a URL in the integrated browser; returns the `pageId` |
| `read_page` | Read the page content (accessibility/text snapshot) |
| `screenshot_page` | Capture a screenshot (returned to the agent as an image) |
| `navigate_page` | Navigate the page (`url`, or `reload` / `back` / `forward`) |
| `click_element` | Click an element |
| `type_in_page` | Type text |
| `hover_element` | Hover an element |
| `drag_element` | Drag from one element to another |
| `handle_dialog` | Accept/dismiss a native JS dialog |
| `run_playwright_code` | Run arbitrary Playwright code against the page |
| `save_page_screenshot` | **(bridge extra)** Write a screenshot to a file and return the path |

`save_page_screenshot` writes the image bytes straight to disk (default
`.tmp/browser-shots/` in the workspace) instead of sending them through the model, so
agents can keep screenshots for reports or diffs.

Pages stay in your control: each open tab has a **sharing** button, and you can revoke an
agent's access to a page at any time. Sharing a page *is* the authorization — VS Code's
explicit-sharing security model stays fully in effect.

---

The rest of this document is reference detail.

## Routing & multiple windows

Each VS Code window runs its own bridge and injects `VSCODE_BROWSER_BRIDGE_INSTANCE` into
its integrated terminals (the same mechanism Git uses for `VSCODE_GIT_IPC_HANDLE`). An
agent started from a terminal therefore drives **exactly the window it was launched
from** — open windows A and B, run an agent in each, and they stay independent. Browser
tabs and confirmation dialogs always appear in the window the agent is connected to.

Agents started **outside** a VS Code terminal get no browser tools by design: the bridge
stays idle (the MCP handshake succeeds but the tool list is empty), and attaches by
itself once a window becomes resolvable. To drive a window from outside (plain ssh,
cron, ...), opt in explicitly with a bridge argument:

- `--discover` — scan all VS Code globalStorage roots and pick the window whose workspace
  folders contain the agent's working directory (longest match wins, then most recently
  started).
- `--workspace <dir>` (or `VSCODE_BROWSER_BRIDGE_WORKSPACE`) — match for that directory.
- `--url <endpoint>` / `--token <token>` — pin a fixed endpoint.

## Connecting any MCP client

The bridge is a standard MCP server, so any client works. Pick the transport it supports:

**stdio** (most clients — Claude Desktop, Cline, Continue, ...). Run the bridge with
`node` and point at the version-independent path:

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

Routing relies on `VSCODE_BROWSER_BRIDGE_INSTANCE`. Launch the client from a VS Code
integrated terminal and most clients pass it through automatically. If a client starts
elsewhere or strips the environment, either forward that one variable (e.g. an `"env"`
entry, or the client's equivalent of Codex's `env_vars`), or pin the target with the
`--url` / `--workspace` / `--discover` arguments above.

**streamable HTTP** (clients that speak it natively). Skip the stdio bridge and connect
straight to the endpoint with the bearer token:

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
`<globalStorage>/instances/<key>.json` (or copy them from *Show Status*). The port can
change on reload, so for long-lived configs the stdio bridge is preferable — it
re-resolves the endpoint by itself, whereas a hard-coded HTTP URL must be updated by hand.

## Confirmation dialogs

VS Code core (not this extension) shows a confirmation dialog for the actions that change
what the browser is pointing at. Without a chat context they appear as plain modal
dialogs, with no "Always Allow", so by default they fire on **every** call of:

| Tool call | Dialog |
| --- | --- |
| `open_browser_page` with a URL | "Open Browser Page?" — even when an already-shared page is reused |
| `navigate_page` to a URL | "Navigate Browser?" — `reload` / `back` / `forward` never prompt |
| `run_playwright_code` | "Run Playwright Code?" — shows the full code for review |

Everything else (`read_page`, `screenshot_page`, `save_page_screenshot`, `click_element`,
`type_in_page`, `hover_element`, `drag_element`, `handle_dialog`) runs without
confirmation on a shared page.

### Skipping the dialogs

VS Code's `chat.tools.global.autoApprove` setting also applies to calls made through this
bridge. Use the per-tool map and keep `run_playwright_code` interactive — its dialog is
what lets you review arbitrary code before it runs:

```jsonc
// User settings (settings.json)
"chat.tools.global.autoApprove": {
  "open_browser_page": true,
  "navigate_page": true
}
```

- Map keys are tool **ids** (`open_browser_page`), not reference names (`openBrowserPage`).
- The first auto-approved call triggers a one-time opt-in warning; enterprise policy can
  disable global auto-approval entirely.
- `chat.tools.eligibleForAutoApproval` works the opposite way: set a tool (by reference
  name, e.g. `"runPlaywrightCode": false`) to always force a confirmation.
- `chat.tools.urls.autoApprove` does **not** apply here — it only covers the web fetch
  tool, not browser navigation.

## Extension settings

| Setting | Default | Description |
| --- | --- | --- |
| `browserBridge.autoStart` | `true` | Start the MCP server on startup |
| `browserBridge.port` | `7345` | Preferred port (falls back to a free port) |
| `browserBridge.requireAuth` | `true` | Require the bearer token from the instance file |

## How it works

VS Code registers its integrated-browser tools in the workbench's internal language-model
tool service, and the stable extension API `vscode.lm.tools` / `vscode.lm.invokeTool`
exposes them to extensions. This extension starts a small MCP server (streamable HTTP,
bound to `127.0.0.1`, bearer-token auth) inside the extension host and mirrors the browser
tools through it. The agent, the stdio bridge, and the extension host always live on the
**same machine**, reaching each other over `127.0.0.1`:

```
Claude Code / Codex  ──stdio──▶  stdio-bridge.mjs  ──HTTP/127.0.0.1──▶  extension host
                                                                              │ vscode.lm.invokeTool
                                                                              ▼
                                                                VS Code workbench
                                                                └─ integrated browser (a tab)
```

- **Local VS Code** — the extension host, the bridge, the agent, and the browser are all
  on your machine; `vscode.lm.invokeTool` runs in-process.
- **Remote-SSH** — the extension (declared `extensionKind: ["workspace", "ui"]`) runs in
  the **remote** extension host, so the MCP endpoint and discovery files live on the
  remote, exactly where your terminal agents run. The `vscode.lm.invokeTool` call is
  proxied back to the local workbench, where the browser renders. Dev servers on the
  remote are reachable in that browser through VS Code's port forwarding.

### Where things live

Discovery state (per-window instance files, the auth token, and a version-independent
copy of the stdio bridge) lives in the extension's **globalStorage** — VS Code's own
per-extension storage. Nothing is written into your workspaces or extra home-dir
dotfiles. The root depends on where the extension host runs:

| Setup | globalStorage root |
| --- | --- |
| Remote-SSH | `~/.vscode-server/data/User/globalStorage/theozhao.vscode-browser-bridge/` |
| Local, Linux | `~/.config/Code/User/globalStorage/theozhao.vscode-browser-bridge/` |
| Local, macOS | `~/Library/Application Support/Code/User/globalStorage/theozhao.vscode-browser-bridge/` |
| Local, Windows | `%APPDATA%\Code\User\globalStorage\theozhao.vscode-browser-bridge\` |

The extension refreshes the `stdio-bridge.mjs` copy in this folder on every activation, so
agent configs that point at `<globalStorage>/stdio-bridge.mjs` keep working across
upgrades — unlike the versioned extension install folder
(`.../theozhao.vscode-browser-bridge-0.2.9/`), which disappears on upgrade.

## Troubleshooting

- **`tools/list` is empty / tool not available** — enable
  `workbench.browser.enableChatTools`; confirm your VS Code is ≥ 1.110 desktop. If the
  agent was started outside a VS Code terminal, see
  [Routing & multiple windows](#routing--multiple-windows).
- **Codex shows `Tools: (none)` inside a VS Code terminal** — Codex spawns MCP servers
  with a sanitized environment that strips `VSCODE_BROWSER_BRIDGE_INSTANCE`. Add
  `env_vars = ["VSCODE_BROWSER_BRIDGE_INSTANCE"]` to the server's table in
  `~/.codex/config.toml`. (`Auth: Unsupported` in Codex's MCP list is harmless — it just
  means the server has no OAuth, which stdio servers never do.)
- **401 from the bridge** — the agent cached an old token; restart its MCP connection
  (e.g. `/mcp` reconnect in Claude Code) to pick up the current one.
- **Bridge unreachable after a window reload** — the extension host restarts and may come
  back on a different port. The instance file path is stable (derived from the workspace
  identity), and the bridge re-resolves and retries for ~15 s on failure, so running agent
  sessions survive a reload; only calls made while VS Code is fully closed fail.
- **Bridge unreachable persistently** — the VS Code window is closed or the extension
  stopped. Check the *Browser Bridge* output channel.
