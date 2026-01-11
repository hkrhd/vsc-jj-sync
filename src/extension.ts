import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const idleMs = 3 * 60 * 1000;
const pullIntervalMs = 60 * 1000;

const workspaceStates = new Map<string, WorkspaceState>();
let extensionContext: vscode.ExtensionContext;

interface WorkspaceState {
	folder: vscode.WorkspaceFolder;
	watcher?: vscode.FileSystemWatcher;
	idleTimer?: NodeJS.Timeout;
	pullTimer?: NodeJS.Timeout;
	jjInProgress: boolean;
	commitBlockedUntilChange: boolean;
	pullErrorNotified: boolean;
	missingGitignoreNotified: boolean;
	gitignoreApproved: boolean;
	enabled: boolean;
}

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;

	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		ensureWorkspaceState(folder);
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.added) {
				ensureWorkspaceState(folder);
			}
			for (const folder of event.removed) {
				disposeWorkspaceState(folder);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('jjSync.enabled')) {
				return;
			}
			for (const state of workspaceStates.values()) {
				void refreshWorkspaceState(state);
			}
		}),
		vscode.workspace.onDidRenameFiles((event) => {
			for (const file of event.files) {
				const folder =
					vscode.workspace.getWorkspaceFolder(file.newUri) ??
					vscode.workspace.getWorkspaceFolder(file.oldUri);
				if (!folder) {
					continue;
				}
				const state = workspaceStates.get(folder.uri.toString());
				if (!state) {
					continue;
				}
				onFileActivity(state, file.newUri);
			}
		})
	);
}

export function deactivate() {
	for (const state of workspaceStates.values()) {
		stopWorkspaceSync(state);
	}
	workspaceStates.clear();
}

function ensureWorkspaceState(folder: vscode.WorkspaceFolder) {
	const key = folder.uri.toString();
	let state = workspaceStates.get(key);
	if (!state) {
		state = {
			folder,
			jjInProgress: false,
			commitBlockedUntilChange: false,
			pullErrorNotified: false,
			missingGitignoreNotified: false,
			gitignoreApproved: false,
			enabled: false,
		};
		workspaceStates.set(key, state);
	}
	state.folder = folder;
	state.gitignoreApproved = extensionContext.workspaceState.get<boolean>(
		approvalKey(folder),
		false
	);
	void refreshWorkspaceState(state);
}

function disposeWorkspaceState(folder: vscode.WorkspaceFolder) {
	const key = folder.uri.toString();
	const state = workspaceStates.get(key);
	if (!state) {
		return;
	}
	stopWorkspaceSync(state);
	workspaceStates.delete(key);
}

async function refreshWorkspaceState(state: WorkspaceState) {
	state.enabled = isEnabled(state.folder);
	if (!state.enabled) {
		stopWorkspaceSync(state);
		return;
	}

	const allowSync = await ensureGitignoreGate(state);
	if (!allowSync) {
		stopWorkspaceSync(state);
		return;
	}

	startWorkspaceSync(state);
}

function isEnabled(folder: vscode.WorkspaceFolder): boolean {
	return vscode.workspace.getConfiguration('jjSync', folder).get('enabled', false);
}

async function ensureGitignoreGate(state: WorkspaceState): Promise<boolean> {
	if (hasGitignore(state.folder.uri.fsPath)) {
		return true;
	}
	if (state.gitignoreApproved) {
		return true;
	}
	if (state.missingGitignoreNotified) {
		return false;
	}

	state.missingGitignoreNotified = true;
	const choice = await vscode.window.showWarningMessage(
		`No .gitignore found in ${state.folder.name}. Click to enable sync anyway.`,
		'Enable Sync'
	);
	if (choice !== 'Enable Sync') {
		return false;
	}

	state.gitignoreApproved = true;
	await extensionContext.workspaceState.update(approvalKey(state.folder), true);
	return true;
}

function startWorkspaceSync(state: WorkspaceState) {
	if (!state.watcher) {
		const pattern = new vscode.RelativePattern(state.folder, '**');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		watcher.onDidCreate((uri) => onFileActivity(state, uri));
		watcher.onDidChange((uri) => onFileActivity(state, uri));
		watcher.onDidDelete((uri) => onFileActivity(state, uri));
		state.watcher = watcher;
		extensionContext.subscriptions.push(watcher);
	}

	if (!state.pullTimer) {
		state.pullTimer = setInterval(() => {
			void runPull(state, 'interval');
		}, pullIntervalMs);
	}

	void runPull(state, 'startup');
}

function stopWorkspaceSync(state: WorkspaceState) {
	if (state.watcher) {
		state.watcher.dispose();
		state.watcher = undefined;
	}
	if (state.idleTimer) {
		clearTimeout(state.idleTimer);
		state.idleTimer = undefined;
	}
	if (state.pullTimer) {
		clearInterval(state.pullTimer);
		state.pullTimer = undefined;
	}
	state.commitBlockedUntilChange = false;
	state.jjInProgress = false;
}

function onFileActivity(state: WorkspaceState, uri: vscode.Uri) {
	if (!state.enabled) {
		return;
	}
	if (isIgnoredPath(state.folder.uri.fsPath, uri.fsPath)) {
		return;
	}
	state.commitBlockedUntilChange = false;
	resetIdleTimer(state);
}

function resetIdleTimer(state: WorkspaceState) {
	if (state.idleTimer) {
		clearTimeout(state.idleTimer);
	}
	state.idleTimer = setTimeout(() => {
		void handleIdle(state);
	}, idleMs);
}

async function handleIdle(state: WorkspaceState) {
	if (!state.enabled || state.jjInProgress || state.commitBlockedUntilChange) {
		return;
	}

	const allowSync = await ensureGitignoreGate(state);
	if (!allowSync) {
		return;
	}

	state.jjInProgress = true;
	try {
		await runPull(state, 'before-push');
		const hasChanges = await hasPendingChanges(state.folder.uri.fsPath);
		if (!hasChanges) {
			return;
		}
		const message = os.hostname() || 'jj-sync';
		await runJj(['commit', '-m', message], state.folder.uri.fsPath);
		await runJj(['git', 'push', '-b', 'main'], state.folder.uri.fsPath);
	} catch (error) {
		state.commitBlockedUntilChange = true;
		vscode.window.showErrorMessage(
			`jj-sync failed in ${state.folder.name}: ${formatError(error)}`
		);
	} finally {
		state.jjInProgress = false;
	}
}

async function runPull(state: WorkspaceState, reason: 'startup' | 'interval' | 'before-push') {
	const reuseInProgress = state.jjInProgress && reason === 'before-push';
	if (state.jjInProgress && !reuseInProgress) {
		return;
	}

	if (!reuseInProgress) {
		state.jjInProgress = true;
	}
	try {
		await runJj(['git', 'fetch'], state.folder.uri.fsPath);
		await runJj(['git', 'import'], state.folder.uri.fsPath);
		state.pullErrorNotified = false;
	} catch (error) {
		if (!state.pullErrorNotified) {
			state.pullErrorNotified = true;
			vscode.window.showErrorMessage(
				`jj-sync pull failed in ${state.folder.name}: ${formatError(error)}`
			);
		}
		if (reason === 'before-push') {
			throw error;
		}
	} finally {
		if (!reuseInProgress) {
			state.jjInProgress = false;
		}
	}
}

async function hasPendingChanges(cwd: string): Promise<boolean> {
	const output = await runJj(['--color=never', 'diff', '--summary'], cwd);
	return output.trim().length > 0;
}

async function runJj(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('jj', args, { cwd });
	return stdout ?? '';
}

function hasGitignore(rootPath: string): boolean {
	return fs.existsSync(path.join(rootPath, '.gitignore'));
}

function approvalKey(folder: vscode.WorkspaceFolder): string {
	return `jjSync.gitignoreApproved:${folder.uri.fsPath}`;
}

function isIgnoredPath(rootPath: string, targetPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return true;
	}
	return relative === '.jj' || relative.startsWith(`.jj${path.sep}`);
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
