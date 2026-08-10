import * as vscode from 'vscode';

// Event handles
let textEditorEvent: vscode.Disposable | null = null;
let textDocEvent: vscode.Disposable | null = null;

// Constants
const WORKSPACE_SECTION = "mini-gradient-preview";
const noDecorationType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({});
const GRADIENT_REGEX = /(?:linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient)\(/i;

/**
 * Builds an array of [start, end] offset pairs for every /* ... *\/ block in text.
 */
export function buildCommentRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const start = i;
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        ranges.push([start, text.length]);
        break;
      }
      ranges.push([start, end + 2]);
      i = end + 2;
    } else {
      i++;
    }
  }
  return ranges;
}

/**
 * Returns true if the given offset falls inside any comment range.
 */
export function isInComment(offset: number, commentRanges: [number, number][]): boolean {
  return commentRanges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * Returns dynamic decoration based on font size, preview size, and box shadow.
 */
export function getDecoration(gradientValue: string): vscode.DecorationInstanceRenderOptions {
  const config = vscode.workspace.getConfiguration(WORKSPACE_SECTION);
  const sizeSetting = config.get<number>('size', 40);
  const boxShadow = config.get<string>('boxShadow', '0 0 2px 1px rgba(0, 0, 0, 0.5)');
  const borderRadius = config.get<string>('borderRadius', '33%');

  const editorConfig = vscode.workspace.getConfiguration('editor');
  const fontSize = parseFloat(editorConfig.get('fontSize') as string) || 14;

  const width: number = sizeSetting * (fontSize / 14);
  const bottom: number = 4 * (fontSize / 14);

  const beforeOptions: any = {
    contentText: "",
    height: "90%",
    width: `${width}px`,
    margin: `0px 4px -${bottom}px 1px`,
    backgroundColor: `transparent; background-image: ${gradientValue}; box-shadow: ${boxShadow}; border-radius: ${borderRadius};`,
    border: "none",
    boxShadow: boxShadow,
    borderRadius: borderRadius
  };

  return {
    before: beforeOptions
  };
}

/**
 * Checks if the given document's language or file extension is enabled in settings.
 */
export function isFileTypeSupported(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration(WORKSPACE_SECTION);
  const fileTypes = config.get<string[]>('fileTypes', ['css', 'scss', 'less', 'html']);

  const langId = document.languageId.toLowerCase();
  const uriPath = document.uri.path.toLowerCase();

  return fileTypes.some(ft => {
    const cleanFt = ft.toLowerCase().trim().replace(/^\./, '');
    return langId === cleanFt || uriPath.endsWith('.' + cleanFt);
  });
}

/**
 * Checks if the document is HTML or HTML-like.
 */
export function isHtmlDocument(document: vscode.TextDocument): boolean {
  const langId = document.languageId.toLowerCase();
  const uriPath = document.uri.path.toLowerCase();
  const htmlLangs = ['html', 'htm', 'xhtml', 'vue', 'svelte', 'php', 'jsx', 'tsx', 'astro', 'blade'];
  if (htmlLangs.includes(langId) || htmlLangs.some(ext => uriPath.endsWith('.' + ext))) {
    return true;
  }
  const text = document.getText(new vscode.Range(0, 0, 100, 0));
  return /<[a-z1-6]+[\s>]/i.test(text);
}

/**
 * Collects CSS variable declarations (--var-name: value) from open workspace text documents.
 */
export function collectCssVariables(
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments
): Map<string, string> {
  const varMap = new Map<string, string>();
  const varRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g;

  for (const doc of documents) {
    varRegex.lastIndex = 0;
    const text = doc.getText();
    let match: RegExpExecArray | null;
    while ((match = varRegex.exec(text)) !== null) {
      const varName = `--${match[1]}`;
      const varValue = match[2].trim();
      varMap.set(varName, varValue);
    }
  }

  return varMap;
}

/**
 * Recursively resolves var(--var-name, fallback) references in a string.
 */
export function resolveVariableString(value: string, varMap: Map<string, string>, depth = 0): string {
  if (depth > 5 || !value.includes('var(')) {
    return value;
  }

  return value.replace(/var\(\s*--([a-zA-Z0-9_-]+)(?:\s*,\s*([^)]+))?\s*\)/g, (fullMatch, varNameOnly, fallback) => {
    const varKey = `--${varNameOnly}`;
    if (varMap.has(varKey)) {
      const resolved = varMap.get(varKey)!;
      return resolveVariableString(resolved, varMap, depth + 1);
    }
    if (fallback !== undefined) {
      return resolveVariableString(fallback.trim(), varMap, depth + 1);
    }
    return fullMatch;
  });
}

/**
 * Extracts a complete gradient expression with balanced parentheses starting at startOffset.
 */
export function extractGradientAt(text: string, startOffset: number): { fullGradient: string; endOffset: number } | null {
  const openParenIndex = text.indexOf('(', startOffset);
  if (openParenIndex === -1) {
    return null;
  }

  let stack = 1;
  let i = openParenIndex + 1;
  while (i < text.length && stack > 0) {
    if (text[i] === '(') {
      stack++;
    } else if (text[i] === ')') {
      stack--;
    }
    i++;
  }
  if (stack === 0) {
    return {
      fullGradient: text.substring(startOffset, i),
      endOffset: i
    };
  }
  return null;
}

/**
 * Maps CSS class names (.class-name { ... }) to gradient strings by checking any property declaration
 * (e.g. background, background-image, --variable, or custom properties) that resolves to a gradient.
 */
export function collectClassToGradientMap(
  varMap: Map<string, string>,
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments
): Map<string, string> {
  const classMap = new Map<string, string>();
  const classRuleRegex = /\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{([^}]+)\}/g;

  for (const doc of documents) {
    classRuleRegex.lastIndex = 0;
    const text = doc.getText();
    let match: RegExpExecArray | null;
    while ((match = classRuleRegex.exec(text)) !== null) {
      const className = match[1];
      const body = match[2];
      // Strip /* ... */ comments from the property body before matching,
      // so any gradient or var() hidden inside a comment is ignored.
      const strippedBody = body.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
      const propRegex = /(?:[a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = propRegex.exec(strippedBody)) !== null) {
        const rawValue = pMatch[1].trim();
        const resolvedValue = resolveVariableString(rawValue, varMap);
        const gradMatch = GRADIENT_REGEX.exec(resolvedValue);
        if (gradMatch) {
          const gradExtract = extractGradientAt(resolvedValue, gradMatch.index);
          if (gradExtract) {
            classMap.set(className, gradExtract.fullGradient);
            break;
          }
        }
      }
    }
  }

  return classMap;
}

/**
 * Decorates CSS/SCSS/LESS documents.
 */
function decorateCssDocument(
  editor: vscode.TextEditor,
  varMap: Map<string, string>,
  decorations: vscode.DecorationOptions[],
  addedOffsets: Set<number>
) {
  const document = editor.document;
  const text = document.getText();
  const commentRanges = buildCommentRanges(text);
  const gradientGlobalRegex = /(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient)\(/g;

  let match: RegExpExecArray | null;
  while ((match = gradientGlobalRegex.exec(text)) !== null) {
    const startPos = match.index;
    if (isInComment(startPos, commentRanges)) {
      continue;
    }
    const extracted = extractGradientAt(text, startPos);
    if (extracted) {
      const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
      const pos = document.positionAt(startPos);
      const offset = document.offsetAt(pos);
      if (!addedOffsets.has(offset)) {
        addedOffsets.add(offset);
        decorations.push({
          range: new vscode.Range(pos, pos),
          renderOptions: getDecoration(resolvedGrad)
        });
      }
      gradientGlobalRegex.lastIndex = extracted.endOffset;
    }
  }

  const varUsageRegex = /var\(\s*--[a-zA-Z0-9_-]+(?:\s*,\s*[^)]+)?\s*\)/g;
  while ((match = varUsageRegex.exec(text)) !== null) {
    const startPos = match.index;
    if (isInComment(startPos, commentRanges)) {
      continue;
    }
    const rawVar = match[0];
    const resolved = resolveVariableString(rawVar, varMap);
    if (GRADIENT_REGEX.test(resolved) && rawVar !== resolved) {
      const pos = document.positionAt(startPos);
      const offset = document.offsetAt(pos);
      if (!addedOffsets.has(offset)) {
        addedOffsets.add(offset);
        decorations.push({
          range: new vscode.Range(pos, pos),
          renderOptions: getDecoration(resolved)
        });
      }
    }
  }
}

/**
 * Decorates HTML documents (style and class attributes, <style> tags).
 */
function decorateHtmlDocument(
  editor: vscode.TextEditor,
  varMap: Map<string, string>,
  classMap: Map<string, string>,
  decorations: vscode.DecorationOptions[],
  addedOffsets: Set<number>
) {
  const document = editor.document;
  const text = document.getText();

  // 1. Process <style>...</style> blocks in HTML
  const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleBlockRegex.exec(text)) !== null) {
    const styleContent = styleMatch[1];
    const blockStartOffset = styleMatch.index + styleMatch[0].indexOf(styleContent);
    const styleCommentRanges = buildCommentRanges(styleContent);

    const gradientGlobalRegex = /(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient)\(/g;
    let gMatch: RegExpExecArray | null;
    while ((gMatch = gradientGlobalRegex.exec(styleContent)) !== null) {
      if (isInComment(gMatch.index, styleCommentRanges)) {
        continue;
      }
      const startPos = blockStartOffset + gMatch.index;
      const extracted = extractGradientAt(text, startPos);
      if (extracted) {
        const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
        const pos = document.positionAt(startPos);
        const offset = document.offsetAt(pos);
        if (!addedOffsets.has(offset)) {
          addedOffsets.add(offset);
          decorations.push({
            range: new vscode.Range(pos, pos),
            renderOptions: getDecoration(resolvedGrad)
          });
        }
        gradientGlobalRegex.lastIndex = gMatch.index + extracted.fullGradient.length;
      }
    }
  }

  // 2. Process HTML attributes: style, :style, v-bind:style, class, :class, v-bind:class, x-bind:class
  const attrRegex = /\b(style|:style|v-bind:style|class|:class|v-bind:class|x-bind:class)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = attrRegex.exec(text)) !== null) {
    const attrName = attrMatch[1].toLowerCase();
    const fullAttrMatchStr = attrMatch[0];
    const eqIndex = fullAttrMatchStr.indexOf('=');
    const quoteChar = fullAttrMatchStr.slice(eqIndex).match(/['"]/)?.[0];
    if (!quoteChar) {
      continue;
    }

    const attrVal = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
    const valStartOffset = attrMatch.index + fullAttrMatchStr.indexOf(quoteChar, eqIndex) + 1;

    if (attrName.includes('style')) {
      // Style attribute
      const gradientGlobalRegex = /(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient)\(/g;
      let gMatch: RegExpExecArray | null;
      while ((gMatch = gradientGlobalRegex.exec(attrVal)) !== null) {
        const startPos = valStartOffset + gMatch.index;
        const extracted = extractGradientAt(text, startPos);
        if (extracted) {
          const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
          const pos = document.positionAt(startPos);
          const offset = document.offsetAt(pos);
          if (!addedOffsets.has(offset)) {
            addedOffsets.add(offset);
            decorations.push({
              range: new vscode.Range(pos, pos),
              renderOptions: getDecoration(resolvedGrad)
            });
          }
          gradientGlobalRegex.lastIndex = gMatch.index + extracted.fullGradient.length;
        }
      }

      const varUsageRegex = /var\(\s*--[a-zA-Z0-9_-]+(?:\s*,\s*[^)]+)?\s*\)/g;
      let vMatch: RegExpExecArray | null;
      while ((vMatch = varUsageRegex.exec(attrVal)) !== null) {
        const startPos = valStartOffset + vMatch.index;
        const lineStart = Math.max(attrVal.lastIndexOf(':', vMatch.index), attrVal.lastIndexOf(';', vMatch.index), 0);
        const prefix = attrVal.substring(lineStart, vMatch.index);
        if (/\/\*/.test(prefix)) {
          continue;
        }
        const rawVar = vMatch[0];
        const resolved = resolveVariableString(rawVar, varMap);
        if (GRADIENT_REGEX.test(resolved)) {
          const pos = document.positionAt(startPos);
          const offset = document.offsetAt(pos);
          if (!addedOffsets.has(offset)) {
            addedOffsets.add(offset);
            decorations.push({
              range: new vscode.Range(pos, pos),
              renderOptions: getDecoration(resolved)
            });
          }
        }
      }
    } else if (attrName === 'class') {
      // Standard HTML class attribute
      const tokenRegex = /\S+/g;
      let tMatch: RegExpExecArray | null;
      while ((tMatch = tokenRegex.exec(attrVal)) !== null) {
        const token = tMatch[0];
        const tokenOffset = valStartOffset + tMatch.index;

        // Constraints: cannot start with '.' or digit
        if (token.startsWith('.') || /^[0-9]/.test(token)) {
          continue;
        }

        const gradMatch = GRADIENT_REGEX.exec(token);
        if (gradMatch) {
          const startPos = tokenOffset + gradMatch.index;
          const extracted = extractGradientAt(text, startPos);
          if (extracted) {
            const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
            const pos = document.positionAt(tokenOffset);
            const offset = document.offsetAt(pos);
            if (!addedOffsets.has(offset)) {
              addedOffsets.add(offset);
              decorations.push({
                range: new vscode.Range(pos, pos),
                renderOptions: getDecoration(resolvedGrad)
              });
            }
          }
          continue;
        }

        if (classMap.has(token)) {
          const gradValue = classMap.get(token)!;
          const pos = document.positionAt(tokenOffset);
          const offset = document.offsetAt(pos);
          if (!addedOffsets.has(offset)) {
            addedOffsets.add(offset);
            decorations.push({
              range: new vscode.Range(pos, pos),
              renderOptions: getDecoration(gradValue)
            });
          }
        }
      }
    } else {
      // Alpine.js / Vue dynamic class attributes: :class, v-bind:class, x-bind:class
      // Object keys (quoted or unquoted followed by :)
      const objKeyRegex = /(?:['"]([^'"]+)['"]|([a-zA-Z0-9_-]+))\s*:/g;
      let kMatch: RegExpExecArray | null;

      while ((kMatch = objKeyRegex.exec(attrVal)) !== null) {
        const keyName = kMatch[1] !== undefined ? kMatch[1] : kMatch[2];
        const keySubOffset = kMatch.index + (kMatch[1] !== undefined ? kMatch[0].indexOf(kMatch[1]) : 0);
        const keyOffset = valStartOffset + keySubOffset;

        if (keyName.startsWith('.') || /^[0-9]/.test(keyName)) {
          continue;
        }

        const gradMatch = GRADIENT_REGEX.exec(keyName);
        if (gradMatch) {
          const startPos = keyOffset + gradMatch.index;
          const extracted = extractGradientAt(text, startPos);
          if (extracted) {
            const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
            const pos = document.positionAt(keyOffset);
            const offset = document.offsetAt(pos);
            if (!addedOffsets.has(offset)) {
              addedOffsets.add(offset);
              decorations.push({
                range: new vscode.Range(pos, pos),
                renderOptions: getDecoration(resolvedGrad)
              });
            }
          }
          continue;
        }

        if (classMap.has(keyName)) {
          const gradValue = classMap.get(keyName)!;
          const pos = document.positionAt(keyOffset);
          const offset = document.offsetAt(pos);
          if (!addedOffsets.has(offset)) {
            addedOffsets.add(offset);
            decorations.push({
              range: new vscode.Range(pos, pos),
              renderOptions: getDecoration(gradValue)
            });
          }
        }
      }

      // String literals (in array / ternary, excluding object keys)
      const strLitRegex = /['"]([^'"]+)['"]/g;
      let strMatch: RegExpExecArray | null;

      while ((strMatch = strLitRegex.exec(attrVal)) !== null) {
        const afterStrIndex = strMatch.index + strMatch[0].length;
        const rest = attrVal.slice(afterStrIndex).trimStart();
        if (rest.startsWith(':')) {
          // Object key, already processed above
          continue;
        }

        const strVal = strMatch[1];
        const strOffset = valStartOffset + strMatch.index + 1;

        if (strVal.startsWith('.') || /^[0-9]/.test(strVal)) {
          continue;
        }

        const gradMatch = GRADIENT_REGEX.exec(strVal);
        if (gradMatch) {
          const startPos = strOffset + gradMatch.index;
          const extracted = extractGradientAt(text, startPos);
          if (extracted) {
            const resolvedGrad = resolveVariableString(extracted.fullGradient, varMap);
            const pos = document.positionAt(strOffset);
            const offset = document.offsetAt(pos);
            if (!addedOffsets.has(offset)) {
              addedOffsets.add(offset);
              decorations.push({
                range: new vscode.Range(pos, pos),
                renderOptions: getDecoration(resolvedGrad)
              });
            }
          }
          continue;
        }

        const tokens = strVal.split(/\s+/);
        let currTokenOffset = strOffset;
        for (const token of tokens) {
          if (token && !token.startsWith('.') && !/^[0-9]/.test(token)) {
            if (classMap.has(token)) {
              const gradValue = classMap.get(token)!;
              const pos = document.positionAt(currTokenOffset);
              const offset = document.offsetAt(pos);
              if (!addedOffsets.has(offset)) {
                addedOffsets.add(offset);
                decorations.push({
                  range: new vscode.Range(pos, pos),
                  renderOptions: getDecoration(gradValue)
                });
              }
            }
          }
          currTokenOffset += token.length + 1;
        }
      }
    }
  }
}

function decorate(editor: vscode.TextEditor) {
  if (!isFileTypeSupported(editor.document)) {
    editor.setDecorations(noDecorationType, []);
    return;
  }

  const varMap = collectCssVariables();
  const classMap = collectClassToGradientMap(varMap);
  const decorations: vscode.DecorationOptions[] = [];
  const addedOffsets = new Set<number>();

  const document = editor.document;

  if (isHtmlDocument(document)) {
    decorateHtmlDocument(editor, varMap, classMap, decorations, addedOffsets);
  } else {
    decorateCssDocument(editor, varMap, decorations, addedOffsets);
  }

  editor.setDecorations(noDecorationType, decorations);
}

function addDecorations(event?: vscode.TextDocumentChangeEvent) {
  const editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors;
  if (event) {
    editors.forEach(editor => {
      if (editor.document === event.document) {
        decorate(editor);
      }
    });
    return;
  }
  editors.forEach(editor => {
    decorate(editor);
  });
}

function removeDecorations() {
  const editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors;
  editors.forEach(editor => {
    editor.setDecorations(noDecorationType, []);
  });
}

function showGradients() {
  hideGradients();
  addDecorations();
  textEditorEvent = vscode.window.onDidChangeVisibleTextEditors(() => {
    addDecorations();
  });
  textDocEvent = vscode.workspace.onDidChangeTextDocument(e => {
    addDecorations(e);
  });
}

function hideGradients() {
  if (textEditorEvent !== null) {
    textEditorEvent.dispose();
    textEditorEvent = null;
  }
  if (textDocEvent !== null) {
    textDocEvent.dispose();
    textDocEvent = null;
  }
  removeDecorations();
}

function changeConfiguration(visibility: boolean) {
  const config = vscode.workspace.getConfiguration(WORKSPACE_SECTION);
  config.update("show", visibility, vscode.ConfigurationTarget.Workspace).then();
}

export function activate() {
  const config = vscode.workspace.getConfiguration(WORKSPACE_SECTION);

  if (config.get("show")) {
    showGradients();
  }

  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(WORKSPACE_SECTION) || e.affectsConfiguration('editor.fontSize')) {
      const visibility = vscode.workspace.getConfiguration(WORKSPACE_SECTION).get("show");
      if (visibility) {
        showGradients();
      } else {
        hideGradients();
      }
    }
  });

  vscode.commands.registerCommand('gradientpreview.showgradientpreviews', () => {
    changeConfiguration(true);
  });
  vscode.commands.registerCommand('gradientpreview.hidegradientpreviews', () => {
    changeConfiguration(false);
  });
}


