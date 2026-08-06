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
}

export interface VerificationRunner {
  run(command: VerificationCommand): Promise<CommandEvidenceRecord>;
}
