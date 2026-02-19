import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { selectionStore } from '../store/selectionStore';
import { DesignNode, DesignPaint, DesignColor } from '../types/selection';

// ─── Helpers: colour conversion ─────────────────────────────────────────────

function rgbaToHex({ r, g, b, a }: DesignColor): string {
  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return a < 1
    ? `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`
    : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function primaryFillCss(fills: DesignPaint[]): string | undefined {
  const visible = fills.filter((f) => f.visible !== false);
  if (visible.length === 0) return undefined;
  const first = visible[0];
  if (first.type === 'SOLID' && first.color) {
    return rgbaToHex({ ...first.color, a: (first.color.a ?? 1) * (first.opacity ?? 1) });
  }
  if (first.gradientStops && first.gradientStops.length >= 2) {
    const stops = first.gradientStops
      .map((s) => `${rgbaToHex(s.color)} ${(s.position * 100).toFixed(1)}%`)
      .join(', ');
    const dir = first.type === 'GRADIENT_RADIAL' ? 'circle' : 'to right';
    return first.type === 'GRADIENT_RADIAL'
      ? `radial-gradient(${dir}, ${stops})`
      : `linear-gradient(${dir}, ${stops})`;
  }
  return undefined;
}

// ─── Design tree → compact description string for the LM prompt ─────────────

function describeNode(node: DesignNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  const dims = `${Math.round(node.width)}×${Math.round(node.height)}`;
  let line = `${pad}[${node.type}] "${node.name}" (${dims})`;

  const bg = primaryFillCss(node.fills);
  if (bg) line += ` fill:${bg}`;

  if (node.strokeWeight && node.strokeWeight > 0 && node.strokes.length) {
    const sc = primaryFillCss(node.strokes);
    line += ` stroke:${sc ?? 'present'} ${node.strokeWeight}px`;
  }

  if (node.opacity !== undefined && node.opacity < 1) {
    line += ` opacity:${node.opacity}`;
  }

  if (node.cornerRadius) line += ` radius:${node.cornerRadius}px`;
  if (node.topLeftRadius) {
    line += ` radius:${node.topLeftRadius}/${node.topRightRadius}/${node.bottomRightRadius}/${node.bottomLeftRadius}px`;
  }

  if (node.effects.some((e) => e.type === 'DROP_SHADOW' && e.visible)) {
    const s = node.effects.find((e) => e.type === 'DROP_SHADOW')!;
    const c = s.color ? rgbaToHex(s.color) : 'rgba(0,0,0,0.2)';
    line += ` shadow:(${s.offset?.x ?? 0}px ${s.offset?.y ?? 0}px ${s.radius}px ${c})`;
  }

  if (node.autoLayout) {
    const al = node.autoLayout;
    line += ` layout:${al.mode} gap:${al.spacing}px pad:${al.paddingTop}/${al.paddingRight}/${al.paddingBottom}/${al.paddingLeft}`;
  }

  if (node.type === 'TEXT' && node.characters) {
    const preview = node.characters.length > 60
      ? node.characters.slice(0, 60) + '…'
      : node.characters;
    line += ` text:"${preview}"`;
    if (node.textStyle) {
      const ts = node.textStyle;
      line += ` font:${ts.fontFamily} ${ts.fontSize}px/${ts.fontWeight} align:${ts.textAlignHorizontal}`;
    }
  }

  lines.push(line);

  if (node.children) {
    for (const child of node.children) {
      if (child.visible !== false) {
        lines.push(describeNode(child, indent + 1));
      }
    }
  }

  return lines.join('\n');
}

// ─── Build the LM prompt ─────────────────────────────────────────────────────

function buildPrompt(designTree: DesignNode): string {
  const description = describeNode(designTree, 0);

  return `You are an expert front-end developer. Convert the following Figma design tree into a single self-contained HTML file with embedded CSS.

DESIGN TREE:
${description}

RULES:
1. Output ONE complete HTML file, nothing else — no explanations, no markdown fences.
2. Use semantic HTML5 elements (header, nav, main, section, article, footer, button, p, h1-h6, etc.).
3. Embed all CSS inside a <style> tag in the <head>.
4. Map fills to CSS background-color or background (gradient), strokes to border.
5. Map auto-layout (HORIZONTAL → flexbox row, VERTICAL → flexbox column) with matching gap and padding.
6. Map corner radius → border-radius, drop-shadow → box-shadow or filter: drop-shadow.
7. Map text styles: font-family, font-size, font-weight, line-height, letter-spacing, text-align.
8. Use CSS custom properties (var(--*)) for repeated colours.
9. Make the layout responsive (max-width on the outermost container, flexible widths for children).
10. If no fonts are available, fall back to system-ui, sans-serif.
11. Do NOT use external images — use background-color placeholders for image fills.
12. Start the output with <!DOCTYPE html> on the very first line.`;
}

// ─── Strip markdown fences if the model wraps its output ────────────────────

function stripFences(text: string): string {
  // Remove ```html ... ``` or ``` ... ```
  return text
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ─── Main command ────────────────────────────────────────────────────────────

export async function buildWebpageCommand(context: vscode.ExtensionContext): Promise<void> {
  const selection = selectionStore.get();

  if (!selection) {
    vscode.window.showWarningMessage(
      'No Figma selection — click a node in Figma first, then try again.',
    );
    return;
  }

  if (!selection.designTree) {
    vscode.window.showWarningMessage(
      'Design tree not available. Make sure you are using the updated Figma plugin (v2+) and re-select the node.',
    );
    return;
  }

  // Pick the best available LM
  const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' })
    .then((m) => m.length ? m : vscode.lm.selectChatModels({ family: 'claude-sonnet' }))
    .then((m) => m.length ? m : vscode.lm.selectChatModels({}));

  if (!models.length) {
    vscode.window.showErrorMessage(
      'No language model available. Install GitHub Copilot and sign in.',
    );
    return;
  }

  const model = models[0];
  const nodeName = selection.metadata.nodeName;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Figma → HTML: generating "${nodeName}"…`,
      cancellable: true,
    },
    async (_progress, cancelToken) => {
      const prompt = buildPrompt(selection.designTree!);
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];

      let fullText = '';

      try {
        const response = await model.sendRequest(messages, {}, cancelToken);
        for await (const part of response.text) {
          fullText += part;
        }
      } catch (err: any) {
        if (err instanceof vscode.CancellationError) return;
        vscode.window.showErrorMessage(`LM error: ${err.message ?? String(err)}`);
        return;
      }

      const html = stripFences(fullText);

      if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) {
        vscode.window.showErrorMessage(
          'Model did not return valid HTML. Try again or check the Copilot output.',
        );
        return;
      }

      // Write to workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const outputDir = workspaceFolders?.[0]?.uri.fsPath
        ?? context.globalStorageUri.fsPath;

      const safeName = nodeName
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 40);

      const fileName = `figma-${safeName || 'output'}.html`;
      const filePath = path.join(outputDir, fileName);

      fs.writeFileSync(filePath, html, 'utf8');

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: false });

      // Offer to open in browser preview
      const open = await vscode.window.showInformationMessage(
        `✅ Webpage generated: ${fileName}`,
        'Open Preview',
      );
      if (open === 'Open Preview') {
        await vscode.commands.executeCommand(
          'simpleBrowser.show',
          vscode.Uri.file(filePath).toString(),
        );
      }
    },
  );
}
