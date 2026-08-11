import type { CommandEvidenceRecord } from "./result";
import type { VerificationCommand } from "./work-item";

export interface GitVerificationAdapter {
  resolveCommit(revision: string): Promise<string | null>;
  isAncestor(
    ancestorCommit: string,
    descendantCommit: string,
  ): Promise<boolean>;
  readHeadCommit(): Promise<string>;
  isWorktreeCleanExcludingFounder(): Promise<boolean>;
  listWorktreeChangedFilesExcludingFounder?(): Promise<string[]>;
  listChangedFiles(
    baseCommit: string,
    resultCommit: string,
  ): Promise<string[]>;
  /**
   * Commits exactly the declared worktree paths and returns the new commit.
   * Agents never run Git themselves: the controller authors the commit so that no
   * founder ever has to approve Git plumbing to let a result land. Unrelated
   * retained worktree changes must remain untouched.
   */
  commitWorktreeExcludingFounder?(
    message: string,
    paths: readonly string[],
  ): Promise<string>;
}

export interface VerificationRunner {
  run(command: VerificationCommand): Promise<CommandEvidenceRecord>;
}
