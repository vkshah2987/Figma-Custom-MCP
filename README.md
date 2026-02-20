# Figma MCP Bridge

> A standalone **MCP server** that connects the Figma desktop plugin to any AI client — VS Code Copilot, Claude Desktop, Cursor, or any MCP-compatible tool. Select a node in Figma, and your AI can see the full design tree.

## How It Works

```
Figma Desktop Plugin
        │  POST /selection  (node metadata + design tree)
        ▼
┌─────────────────────────────────────────┐
│  packages/mcp-server  (Bridge Daemon)   │
│  Express HTTP  0.0.0.0:3050             │
│  SelectionStore  (in-memory)            │
└────────────────┬────────────────────────┘
                 │  GET /selection  (HTTP)
                 ▼
┌─────────────────────────────────────────┐
│  packages/mcp-server  (MCP Process)     │
│  StdioServerTransport                   │
│  tools + resources  ──► AI Client       │
└─────────────────────────────────────────┘
```

The server binary runs in **two modes**:

| Mode | Command | Purpose |
|---|---|---|
| **Bridge daemon** | `BRIDGE_ONLY=1 node packages/mcp-server/dist/index.js` | Receives Figma plugin POSTs, holds selection in memory |
| **MCP stdio** | Spawned automatically by VS Code / Claude / Cursor | Exposes tools to AI; fetches live data from bridge via HTTP |

This two-process design means the MCP client always reads **live selection data** even though clients like VS Code spawn a fresh stdio process per session.

## Features

- **Client-agnostic** — works with VS Code Copilot, Claude Desktop, Cursor, or any MCP client
- **Design tree extraction** — full recursive node tree (fills, strokes, typography, effects, auto-layout)
- **MCP Tools** — `get_current_figma_selection`, `clear_figma_selection`, `get_bridge_health`
- **MCP Resource** — `figma://selection` returns the current design tree as JSON
- **Zero config** — no API keys, no OAuth, no Docker
- **npm workspaces monorepo** — plugin and server are independent packages under one repo

## Repository Structure

```
figma-mcp-server/                    ← monorepo root
├── package.json                     ← workspace host { "workspaces": ["packages/*"] }
├── .vscode/
│   └── mcp.json                     ← MCP server registration for VS Code
├── packages/
│   ├── mcp-server/                  ← @figma-mcp/server
│   │   ├── src/
│   │   │   ├── index.ts             ← entry point (bridge + MCP stdio)
│   │   │   ├── bridge/
│   │   │   │   └── server.ts        ← Express HTTP bridge (port 3050)
│   │   │   ├── store/
│   │   │   │   └── selectionStore.ts
│   │   │   └── types/
│   │   │       └── selection.ts
│   │   ├── dist/                    ← compiled output (gitignored)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── figma-plugin/                ← @figma-mcp/plugin
│       ├── manifest.json            ← Figma plugin manifest
│       ├── code.ts / code.js        ← plugin sandbox logic
│       ├── ui.html                  ← plugin iframe UI
│       ├── tsconfig.json
│       └── package.json
└── README.md
```

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 |
| Figma Desktop | any recent |
| An MCP client | VS Code Copilot, Claude Desktop, Cursor, etc. |

## Installation

### 1 — Clone and build

```bash
git clone <repo-url>
cd figma-mcp-server

# Install all workspace dependencies from the root
npm install

# Build the MCP server
npm run build
```

### 2 — Start the bridge daemon

The bridge must run as a **persistent background process** so VS Code's MCP stdio process can query it for live selection data.

```bash
BRIDGE_ONLY=1 node packages/mcp-server/dist/index.js </dev/null >bridge.log 2>&1 &
```

- `BRIDGE_ONLY=1` skips the stdio transport so the process never blocks on stdin.
- `</dev/null` prevents the shell from suspending the background job.
- Verify it's alive: `curl http://localhost:3050/health`

### 3 — Register in your MCP client

**VS Code** — `.vscode/mcp.json` is already included in this repo:

```jsonc
{
  "servers": {
    "figma-mcp-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/packages/mcp-server/dist/index.js"]
    }
  }
}
```

After starting the bridge daemon, run **⇧⌘P → MCP: Restart Server → figma-mcp-bridge** in VS Code.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "figma-mcp-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "figma-mcp-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### 4 — Install the Figma plugin

1. Open **Figma Desktop**.
2. Go to **Menu → Plugins → Development → Import plugin from manifest…**
3. Select `packages/figma-plugin/manifest.json`.
4. Run it from **Plugins → Development → Figma MCP Bridge**.

## Usage

1. Start the bridge daemon (step 2 above).
2. In Figma, select any frame or component and run the plugin — it POSTs the full design tree to `localhost:3050`.
3. Ask your AI anything about the selection.

### Example prompts

```
What node do I have selected in Figma right now?
Describe the typography and color scheme of my Figma selection.
Generate a React component matching my Figma selection.
Build a pixel-perfect HTML page from the current Figma selection.
```

## MCP Tools

| Tool | Description |
|---|---|
| `get_current_figma_selection` | Returns the full design tree and metadata for the currently selected node |
| `clear_figma_selection` | Clears the stored selection from the bridge |
| `get_bridge_health` | Returns `{ status, timestamp }` from the Express bridge |

## MCP Resources

| URI | Description |
|---|---|
| `figma://selection` | The current Figma selection as a JSON design tree |

## Bridge HTTP API

| Method | Path | Description |
|---|---|---|
| `POST` | `/selection` | Receive `SelectionPayload` from Figma plugin (10 MB limit) |
| `GET` | `/selection` | Return current selection or `404` |
| `DELETE` | `/selection` | Clear stored selection |
| `GET` | `/health` | `{ status: "healthy", timestamp }` |

```bash
# Check what's selected
curl http://localhost:3050/selection

# Health check
curl http://localhost:3050/health

# Clear selection
curl -X DELETE http://localhost:3050/selection
```

## Development

All scripts run from the **monorepo root**:

```bash
npm install              # install all workspace dependencies
npm run build            # build packages/mcp-server
npm run watch            # TypeScript watch mode
npm run dev              # run via ts-node (no build step needed)
npm run build:all        # build every package that has a build script
```

To work on a specific package directly:

```bash
# Build only the MCP server
npm run build --workspace=packages/mcp-server

# Typecheck only the Figma plugin
npm run typecheck --workspace=packages/figma-plugin
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PORT` | `3050` | Port for the Express HTTP bridge |
| `BRIDGE_ONLY` | `""` | Set to `1` to run as bridge daemon (no MCP stdio) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `get_current_figma_selection` returns "Bridge unreachable" | Bridge daemon isn't running — start it with `BRIDGE_ONLY=1 node packages/mcp-server/dist/index.js </dev/null >bridge.log 2>&1 &` |
| Bridge process gets suspended by the shell | Redirect stdin — add `</dev/null` to the daemon start command |
| MCP client says "server not found" | Check `args` in your MCP config points to `packages/mcp-server/dist/index.js` |
| Port 3050 already in use | Set `BRIDGE_PORT` env var; update the Figma plugin's fetch URL accordingly |
| "No Figma selection available" | Open Figma Desktop, run the plugin, and select a node |
| Plugin shows error on load | Ensure you imported via `packages/figma-plugin/manifest.json`, not a zip |

## License

MIT
