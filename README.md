# Figma MCP Bridge

> A standalone **MCP server** that connects the Figma desktop plugin to any AI client — VS Code Copilot, Claude Desktop, Cursor, or any MCP-compatible tool. Select a node in Figma, and your AI can see the full design tree.

## How It Works

```
Figma Desktop Plugin
        │  POST /selection  (node metadata + design tree)
        ▼
Express Bridge  127.0.0.1:3050  ◄── HTTP receiver
        │
   SelectionStore  (in-memory)
        │
MCP Server  (stdio)  ◄── tools + resources
        │
Any MCP Client  (VS Code Copilot · Claude Desktop · Cursor · …)
```

The server runs **two transports in one process**:

1. **Express HTTP** on port 3050 — receives design-tree pushes from the Figma plugin
2. **MCP stdio** — exposes tools and resources to any MCP-compatible AI client

## Features

- **Client-agnostic** — works with VS Code Copilot, Claude Desktop, Cursor, or any MCP client
- **Design tree extraction** — full recursive node tree (fills, strokes, typography, effects, auto-layout)
- **MCP Tools** — `get_current_figma_selection`, `clear_figma_selection`, `get_bridge_health`
- **MCP Resource** — `figma://selection` returns the current design tree as JSON
- **Zero config** — no API keys, no OAuth, no Docker

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 |
| Figma Desktop | any recent |
| An MCP client | VS Code Copilot, Claude Desktop, Cursor, etc. |

## Installation

### 1 — Clone and build

```bash
git clone <repo-url> && cd figma-mcp-bridge
npm install
npm run build
```

### 2 — Register in your MCP client

**VS Code** — add to `.vscode/mcp.json` (already included in this repo):

```jsonc
{
  "servers": {
    "figma-mcp-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"]
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "figma-mcp-bridge": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"]
    }
  }
}
```

### 3 — Figma Plugin

1. Open **Figma Desktop**.
2. Go to **Menu → Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json` from this repo.
4. Run the plugin from **Plugins → Development → Figma MCP Bridge**.

## Usage

1. In Figma, select any frame or component and run the plugin.
2. The plugin posts the full design tree to `localhost:3050`.
3. In your MCP client, the AI can now call `get_current_figma_selection` — either automatically or via your prompt.

### Example prompts

```
What node do I have selected in Figma right now?
Describe the typography and color scheme of my current Figma selection.
Generate a React component that matches my Figma selection.
Build a landing page HTML from the Figma selection.
```

## MCP Tools

| Tool | Description |
|---|---|
| `get_current_figma_selection` | Returns the full design tree and metadata for the currently selected Figma node |
| `clear_figma_selection` | Clears the stored selection from the bridge |
| `get_bridge_health` | Returns bridge status and port |

## MCP Resources

| URI | Description |
|---|---|
| `figma://selection` | The current Figma selection as JSON |

## Project Structure

```
.
├── src/
│   ├── index.ts                 # MCP server entry point (stdio + bridge)
│   ├── bridge/
│   │   └── server.ts            # Express HTTP bridge (port 3050)
│   ├── store/
│   │   └── selectionStore.ts    # In-memory selection store
│   └── types/
│       └── selection.ts         # DesignNode + SelectionPayload types
├── figma-plugin/
│   ├── manifest.json            # Figma plugin manifest
│   ├── code.js                  # Plugin sandbox (ES5-safe)
│   └── ui.html                  # Plugin UI + bridge POST
├── .vscode/
│   ├── mcp.json                 # MCP server registration for VS Code
│   └── launch.json              # Debug config
├── dist/                        # Compiled output (gitignored)
├── package.json
└── README.md
```

## Bridge HTTP API

The Express bridge runs alongside the MCP server for receiving Figma plugin pushes:

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/selection` | `SelectionPayload` JSON |
| `GET` | `/selection` | Current `SelectionPayload` or `404` |
| `DELETE` | `/selection` | Clears stored selection |
| `GET` | `/health` | `{ status: "healthy" }` |

```bash
# Check what's selected
curl http://127.0.0.1:3050/selection

# Health check
curl http://127.0.0.1:3050/health

# Clear selection
curl -X DELETE http://127.0.0.1:3050/selection
```

## Development

```bash
npm install          # install dependencies
npm run build        # one-off TypeScript build
npm run watch        # watch mode
npm start            # run the MCP server
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `3050` | Port for the Express bridge |

## Troubleshooting

| Symptom | Fix |
|---|---|
| MCP client says "server not found" | Check the `command` and `args` path in your MCP config |
| Port 3050 already in use | Set `BRIDGE_PORT` env var to a different port, and update the Figma plugin URL |
| "No Figma selection available" | Run the Figma plugin and select a node |
| Plugin shows error on load | Ensure you imported via **manifest.json**, not a zip |

## License

MIT © figma-mcp
