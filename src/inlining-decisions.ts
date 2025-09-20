import * as vscode from 'vscode';
import * as cp from 'child_process';

export type InlDecisionsMap = Record<number, InlDecision>
export type InlDecision = {
  canInline: boolean;
  isInlined: boolean;
  maxBudget: 80; // Max inlining budget value as of go1.25
  name: string;
  as?: string;
  cost?: string;
}

export function getInlineDecisions({ cwd, fileName }: { cwd: string; fileName: string }): InlDecisionsMap {
  const result = cp.spawnSync(
    "go",
    ["build", "-gcflags=-m=2", cwd + fileName],
    {
      cwd,
      env: { ...process.env },
      encoding: "utf-8"
    }
  );

  const stderr = result.stderr || "";
  if (!stderr) { return []; }

  const decisionsMap: InlDecisionsMap = {};
  const reSuccess = /^(?<file>.+?):(?<codeLine>\d+):(?<col>\d+):\s+can inline (?<name>\S+) with cost (?<cost>\d+) as: (?<text>.+)$/;
  const reFailure = /^(?<file>.+?):(?<codeLine>\d+):(?<col>\d+): cannot inline (?<name>\S+):.*?cost (?<cost>\d+)/;
  const reCall = /^(?<file>.+?):(?<codeLine>\d+):(?<col>\d+): inlining call to (?<name>\S+)$/;

  const lines = stderr.split('\n');

  for (const line of lines) {
    const matchSuccess = line.match(reSuccess);
    const matchFailure = line.match(reFailure);
    const matchCall = line.match(reCall);

    if (matchSuccess?.groups) {
      const { file, codeLine, name, cost, text } = matchSuccess.groups;
      decisionsMap[Number(codeLine)] = { canInline: true, name: name, cost: cost, as: text, isInlined: false, maxBudget: 80 };
    }

    if (matchFailure?.groups) {
      const { file, codeLine, name, cost } = matchFailure.groups;
      decisionsMap[Number(codeLine)] = { canInline: false, name: name, cost: cost, isInlined: false, maxBudget: 80 };
    }

    if (matchCall?.groups) {
      const { codeLine, name } = matchCall.groups;
      decisionsMap[Number(codeLine)] = { canInline: false, name: name, isInlined: true, maxBudget: 80 };
    }
  }

  return decisionsMap;
}

export function inlineDecisionText(decision: InlDecision) {
  if (decision.canInline) {
    return ['can inline', decision.name, 'with cost', decision.cost].join(' ');
  }
  if (decision.isInlined) {
    return ['inlining call to', decision.name].join(' ');
  }
  return ['cannot inline', decision.name + ':', 'cost', decision.cost, 'exceeds budget', decision.maxBudget].join(' ');
}
