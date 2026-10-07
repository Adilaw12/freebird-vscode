import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Appends a timing line to the "Freebird Timing" output channel (View → Output).
 * Never shown automatically and never sent anywhere — it exists so a slow agent run
 * can be diagnosed from real numbers (request time-to-first-byte, tool durations).
 */
export function perfLog(message: string): void {
    try {
        channel ??= vscode.window.createOutputChannel('Freebird Timing');
        channel.appendLine(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
    } catch { /* output channels unavailable (tests, early activation) — logging is best-effort */ }
}
