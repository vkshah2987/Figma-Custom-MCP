import * as vscode from 'vscode';
import { selectionStore } from '../store/selectionStore';

/**
 * The single MCP tool exposed by the extension.
 *
 * Rules (per architecture):
 * - Read-only: does not modify SelectionStore
 * - No external API calls
 * - No disk access
 */
const TOOL_NAME = 'get_current_figma_selection';

export function registerTools(context: vscode.ExtensionContext): void {
  const tool = vscode.lm.registerTool<Record<string, never>>(TOOL_NAME, {
    /**
     * Customise the progress message shown while the tool is running.
     */
    prepareInvocation(
      _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
      _token: vscode.CancellationToken,
    ): vscode.PreparedToolInvocation {
      return {
        invocationMessage: 'Reading current Figma selection…',
      };
    },

    /**
     * Return the latest selection from memory, or an error if nothing is stored.
     */
    invoke(
      _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
      _token: vscode.CancellationToken,
    ): vscode.LanguageModelToolResult {
      const selection = selectionStore.get();

      if (!selection) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            JSON.stringify({
              status: 'error',
              message:
                'No Figma selection available. Open the "Figma MCP Selection Bridge" plugin and click any node.',
            }),
          ),
        ]);
      }

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          JSON.stringify({ status: 'ok', selection }),
        ),
      ]);
    },
  });

  context.subscriptions.push(tool);
}

