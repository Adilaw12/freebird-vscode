import * as vscode from 'vscode';

type GitAPI = any;

export class GitService {
    private getAPI(): GitAPI {
        const ext = vscode.extensions.getExtension('vscode.git');
        if (!ext) throw new Error('Built-in Git extension not found. Please enable it.');
        return ext.exports.getAPI(1);
    }

    private getRepo() {
        const api = this.getAPI();
        const repos = api.repositories;
        if (!repos || repos.length === 0) {
            throw new Error('No git repository found in the current workspace.');
        }
        return repos[0];
    }

    async getDiff(): Promise<string | null> {
        try {
            const repo = this.getRepo();
            const staged = await repo.diff(true);
            const unstaged = await repo.diff(false);
            return staged || unstaged || null;
        } catch {
            return null;
        }
    }

    async commit(message: string): Promise<void> {
        const repo = this.getRepo();
        // Stage all changes if nothing is staged yet
        const hasStaged = repo.state.indexChanges.length > 0;
        if (!hasStaged) {
            const paths = repo.state.workingTreeChanges.map((c: any) => c.uri.fsPath);
            if (paths.length === 0) throw new Error('Nothing to commit.');
            await repo.add(paths);
        }
        await repo.commit(message);
    }

    async push(): Promise<void> {
        const repo = this.getRepo();
        await repo.push();
    }

    async getStatus(): Promise<string> {
        const repo = this.getRepo();
        const staged = repo.state.indexChanges.length;
        const unstaged = repo.state.workingTreeChanges.length;
        const branch = repo.state.HEAD?.name ?? 'unknown';
        return `Branch: ${branch} | Staged: ${staged} | Unstaged: ${unstaged}`;
    }
}
