import * as vscode from 'vscode';
import * as cp from 'child_process';
import { html, TemplateResult } from 'lit-html';
import path from 'path';
import { getInlineDecisions, InlDecisionsMap } from './inlining-decisions.js';
import { InliningDecisionsInlayHintsProvider, InliningLensProvider } from './inlay-hints.js';


export function activate(context: vscode.ExtensionContext) {
	const showSSA = vscode.commands.registerCommand("goSsaExplorer.showSSA", async () => {
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
		const inlineDecisions = getInlineDecisions({ cwd, fileName: ssaFileName });

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

				const inlineDecisions = getInlineDecisions({ cwd, fileName: ssaFileName });

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

	const codeLensProvider = vscode.languages.registerCodeLensProvider(
		{ language: "go" },
		new InliningLensProvider()
	);

	const inliningDecisionsProvider = new InliningDecisionsInlayHintsProvider({});
	const inliningDecisionsDisposable = vscode.languages.registerInlayHintsProvider({ language: 'go' }, inliningDecisionsProvider);
	let showHints = false;

	const toggleInliningDecisions = vscode.commands.registerCommand("goSsaExplorer.toggleInliningDecisions", (absFileName: string) => {
		const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		if (!cwd) { return; }

		let fileName: string;
		if (!absFileName) {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }

			fileName = editor.document.fileName;
		} else {
			fileName = absFileName;
		}

		fileName = '/' + path.relative(cwd, fileName);

		let newHints: InlDecisionsMap;
		if (showHints) {
			newHints = {};
		} else {
			newHints = getInlineDecisions({ cwd, fileName });
		}

		showHints = !showHints;

		inliningDecisionsProvider.refreshInlayHints(newHints);
	});

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
			if (!showHints) { return; }

			const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
			if (!cwd) { return; }

			const fileName = doc.fileName.split(cwd)[1];
			const newHints = getInlineDecisions({ cwd, fileName });

			inliningDecisionsProvider.refreshInlayHints(newHints);
		})
	);

	context.subscriptions.push(codeLensProvider, showSSA, toggleInliningDecisions, inliningDecisionsDisposable);
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