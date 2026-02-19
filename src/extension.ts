import * as vscode from 'vscode';
import { startBridge, stopBridge, getBridgeStatus, onBridgeStatusChange } from './bridge/server';
import { registerTools } from './mcp/tools';
import { buildWebpageCommand } from './commands/buildWebpage';

function applyStatusBar(
  bar: vscode.StatusBarItem,
  status: 'starting' | 'running' | 'error' | 'stopped',
): void {
  switch (status) {
    case 'running':
      bar.text = '$(plug) Figma Bridge';
      bar.tooltip = 'Figma MCP Bridge running on localhost:3050 — click to build webpage';
      bar.backgroundColor = undefined;
      bar.command = 'figmaMcp.buildWebpage';
      break;
    case 'error':
      bar.text = '$(warning) Figma Bridge';
      bar.tooltip = 'Bridge failed to start (port 3050 in use?) — click to retry';
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      bar.command = 'figmaMcp.startBridge';
      break;
    case 'stopped':
      bar.text = '$(debug-stop) Figma Bridge';
      bar.tooltip = 'Bridge stopped — click to start';
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      bar.command = 'figmaMcp.startBridge';
      break;
    default:
      bar.text = '$(loading~spin) Figma Bridge';
      bar.tooltip = 'Starting bridge on localhost:3050…';
      bar.command = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // ── Status bar (registered first — always visible regardless of bridge state) ──
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  applyStatusBar(statusBar, 'starting');
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── React to bridge status changes ──────────────────────────────────────────
  onBridgeStatusChange((s) => applyStatusBar(statusBar, s));

  // ── Commands ─────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('figmaMcp.buildWebpage', () =>
      buildWebpageCommand(context),
    ),
    vscode.commands.registerCommand('figmaMcp.startBridge', () => {
      applyStatusBar(statusBar, 'starting');
      startBridge();
      // Show result after a short delay (listen callback is async)
      setTimeout(() => {
        const s = getBridgeStatus();
        applyStatusBar(statusBar, s);
        if (s === 'running') {
          vscode.window.showInformationMessage('Figma Bridge started on localhost:3050');
        } else {
          vscode.window.showErrorMessage(
            'Bridge failed to start. Is port 3050 already in use? Check Output → Figma MCP.',
          );
        }
      }, 500);
    }),
    vscode.commands.registerCommand('figmaMcp.clearSelection', () => {
      const { selectionStore } =
        require('./store/selectionStore') as typeof import('./store/selectionStore');
      selectionStore.clear();
      vscode.window.showInformationMessage('Figma selection cleared.');
    }),
  );

  // ── Register LM tool ─────────────────────────────────────────────────────────
  try {
    registerTools(context);
  } catch (e) {
    console.error('[Figma MCP] registerTools failed:', e);
  }

  // ── Start bridge (non-fatal — commands are already registered above) ─────────
  try {
    startBridge();
  } catch (e) {
    console.error('[Figma MCP] startBridge threw synchronously:', e);
    applyStatusBar(statusBar, 'error');
  }

  console.log('[Figma MCP] Extension activated');
}

export function deactivate(): void {
  stopBridge();
  console.log('[Figma MCP] Extension deactivated');
}
