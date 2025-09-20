import * as vscode from 'vscode';
import { InlDecisionsMap, inlineDecisionText } from './inlining-decisions.js';

export class InliningLensProvider implements vscode.CodeLensProvider {
  onDidChangeCodeLenses?: vscode.Event<void> | undefined;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    const firstLine = document.lineAt(0);
    const range = new vscode.Range(firstLine.range.start, firstLine.range.start);

    lenses.push(
      new vscode.CodeLens(range, {
        title: "Toggle Inlining Decisions",
        command: "goSsaExplorer.toggleInliningDecisions",
        arguments: [document.fileName],
      })
    );

    return lenses;
  }
}

export class InliningDecisionsInlayHintsProvider implements vscode.InlayHintsProvider {
  private _onDidChangeInlayHints = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

  constructor(public hintsMap: InlDecisionsMap) { }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    const hints: vscode.InlayHint[] = [];

    for (const [lineStr, decision] of Object.entries(this.hintsMap)) {
      const line = Number(lineStr) - 1;
      if (line >= range.start.line && line <= range.end.line) {
        const lineLength = document.lineAt(line).text.length;
        const position = new vscode.Position(line, lineLength);
        const decisionText = ' ' + inlineDecisionText(decision);
        const hint = new vscode.InlayHint(position, decisionText, vscode.InlayHintKind.Type);
        hints.push(hint);
      }
    }

    return hints;
  }

  refreshInlayHints(hintsMap: InlDecisionsMap) {
    this.hintsMap = hintsMap;
    this._onDidChangeInlayHints.fire();
  }
}
