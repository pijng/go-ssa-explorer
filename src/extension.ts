import * as vscode from 'vscode';
import * as cp from 'child_process';
import { html, TemplateResult } from 'lit-html';


export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand("goSsaExplorer.showSSA", async () => {
		const output = vscode.window.createOutputChannel("Go SSA Explorer");
		output.appendLine("Extension activated");

		const funcName = await vscode.window.showInputBox({
			prompt: "Enter the function or method name",
			placeHolder: "package.FunctionName or (*Type).MethodName"
		});
		if (!funcName) { return; }

		const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!cwd) {
			vscode.window.showErrorMessage("No workspace folder open");
			return;
		}

		const { ssa, ssaFileName } = getSSA({ output, cwd, funcName });
		const inlineDecisions = getInlineDecisions({ output, cwd, fileName: ssaFileName });

		const panel = vscode.window.createWebviewPanel(
			'ssaExplorer',
			`SSA: ${funcName}`,
			vscode.ViewColumn.Beside,
			{ enableScripts: true }
		);

		panel.webview.html = htmlToString(html`
			<html>
				<head>
					<style>
						.wrapper {  }
						.title {  }
						.inlining-decision { display: none; }
						body.show-inlining .inlining-decision {
							display: block;
						}
						.highlight { background: aquamarine; }
						#ssa-output { width: fit-content; }
					</style>
				</head>
				<body>
					<div class="wrapper">
						<h2 class="title">ssa</div>
						<button id="show-inlining-decisions">Toggle inlining decisions</button>
						<pre id="ssa-output"></pre>
					</div>
				</body>
				<script>
					window.addEventListener("DOMContentLoaded", () => {
						const ssaEl = document.getElementById("ssa-output");
						function extractCodeLine(line) {
							const match = line.trim().match(/\\(\\s*(\\d+)\\s*\\)/);
    					if (!match) { return null; };
    					return parseInt(match[1], 10);
						}
						function inlineDecisionText(decision) {
							if (decision.canInline) {
								return ['can inline', decision.name, 'with cost', decision.cost].join(' ')
							}
							if (decision.isInlined) {
								return ['inlining call to', decision.name].join(' ')
							}
							return ['cannot inline', decision.name + ':', 'function too complex: cost', decision.cost, 'exceeds budget', decision.maxBudget].join(' ')
						}

						function renderSSA(ssaText, inliningDecisions) {
							const ssaLines = ssaText.split("\\n");
							const seen = {};
							ssaEl.innerHTML = ssaLines.map((l, i) => {
								const tags = [];

								const codeLine = extractCodeLine(l);
								const decision = inliningDecisions[codeLine];
								if (decision && !seen[codeLine]) {
									tags.push('<br class="inlining-decision"><div class="inlining-decision">' + inlineDecisionText(decision) + '</div>')
									seen[codeLine] = true
								}

								tags.push('<div data-line="' + i  + '">' + l + '</div>');

								return tags.join('')
							}).join("");
						}

						renderSSA(${JSON.stringify(ssa)}, ${JSON.stringify(inlineDecisions)});

						window.addEventListener("message", event => {
							const message = event.data;

							if (message.type === "highlight" && message.fileName === "${ssaFileName}") {
								document.querySelectorAll("#ssa-output div").forEach(div => {
									div.classList.remove("highlight")
								});
								document.querySelectorAll("#ssa-output div").forEach(div => {
									if (div.textContent.includes("(" + message.line + ")")) {
										div.classList.add("highlight");
									}
								});
							}

							if (message.type === "updateSSA" && message.fileName === "${ssaFileName}") {
								renderSSA(message.ssa, message.inlineDecisions);

								document.querySelectorAll("#ssa-output div").forEach(div => {
									div.classList.remove("highlight")
								});
								document.querySelectorAll("#ssa-output div").forEach(div => {
									if (div.textContent.includes("(" + message.line + ")")) {
										div.classList.add("highlight");
									}
								});
							}
						});

						document.getElementById('show-inlining-decisions').addEventListener('click', () => {
  						document.body.classList.toggle('show-inlining')
						});
					});
				</script>
			</html>
		`);

		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection(event => {
				if (!panel || !panel.visible) { return; }

				const fileName = event.textEditor.document.fileName.split(cwd)[1];
				const line = event.selections[0].start.line + 1;

				panel.webview.postMessage({ type: "highlight", line: line, fileName: fileName });
			})
		);

		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
				if (!panel || !panel.visible) { return; }

				const fileName = doc.fileName.split(cwd)[1];
				const { ssa } = getSSA({ output, cwd, funcName });
				if (!ssa) { return; }

				const inlineDecisions = getInlineDecisions({ output, cwd, fileName: ssaFileName });

				const editor = vscode.window.activeTextEditor;
				if (!editor) { return; }

				const line = editor?.selection.start.line + 1;

				panel.webview.postMessage({
					type: "updateSSA",
					ssa: ssa,
					inlineDecisions: inlineDecisions,
					line: line,
					fileName: fileName
				});
			})
		);
	});

	context.subscriptions.push(disposable);
}

function getSSA({ output, cwd, funcName }: { output: vscode.OutputChannel; cwd: string; funcName: string }): { ssa: string, ssaFileName: string } {
	const funcNameForStderr = funcName + '+';

	const result = cp.spawnSync(
		"go",
		["build", "./..."],
		{
			cwd,
			env: { ...process.env, GOSSAFUNC: funcNameForStderr },
			encoding: "utf-8"
		}
	);

	const stderr = result.stderr || "";

	const nonPkgFuncName = splitFuncName(funcName);
	output.appendLine(`Output of SSA for \`${funcName}\`:`);
	output.append(stderr);
	const regex = new RegExp(`genssa ${escapeForRegex(nonPkgFuncName)}[\\s\\S]*?(?=dumped SSA)`, "g");
	const match = stderr.match(regex);

	if (!match || match.length <= 0) {
		vscode.window.showErrorMessage(`No SSA output found for: ${funcName}`);
		return { ssa: '', ssaFileName: '' };
	}

	let ssa = match[0];

	const lines = ssa.split(/\r?\n/);
	const removedLines = lines.slice(0, 2);
	const ssaFileName = '/' + removedLines[removedLines.length - 1].replace('#', '').replace('./', '').trim();
	const strippedSsa = lines.slice(2).join("\n");

	return { ssa: strippedSsa, ssaFileName: ssaFileName };
}

type InlDecision = {
	canInline: boolean;
	isInlined: boolean;
	maxBudget: 80; // Max inlining budget value as of go1.25
	name: string;
	as?: string;
	cost?: string;
}

type InlDecisionsMap = Record<number, InlDecision>

function getInlineDecisions({ output, cwd, fileName }: { output: vscode.OutputChannel; cwd: string; fileName: string }): InlDecisionsMap {
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

	output.appendLine(`Output of inlining decisions for \`${fileName}\`:`);
	output.append(stderr);

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

function splitFuncName(funcName: string): string {
	// regex matches Go method: (Type).Method or (*Type).Method
	const methodRegex = /^\(.*\)\..+$/;

	if (methodRegex.test(funcName)) {
		// return as-is if it's a method
		return funcName;
	}

	const parts = funcName.split('.');
	return parts[parts.length - 1];
}

function escapeForRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlToString(template: TemplateResult): string {
	const { strings, values } = template;
	const v = [...values as any, ''].map(e => typeof e === 'object' ? htmlToString(e) : e);
	return strings.reduce((acc, s, i) => acc + s + v[i], '');
}