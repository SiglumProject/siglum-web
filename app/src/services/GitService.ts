/**
 * GitService - Re-exports from @siglum/git package
 *
 * This module configures and exports the git service instance,
 * and switches the file tree root when git connects/disconnects.
 */

import { getGitService } from '@siglum/git'
import { fileSystemWatcher } from './FileSystemWatcher'
import { fileManager } from './FileManager'

// Git files are mounted at /git with their own OPFS namespace
const GIT_ROOT = '/git'

// Create and export the configured git service instance
const gitService = getGitService({
  corsProxy: 'https://cors.isomorphic-git.org',
  storageKey: 'siglum-git-config',
  beforeBranchSwitch: () => fileManager.saveQueue.flushOrThrow(),
  beforeWorkingTreeChange: () => fileManager.saveQueue.flushOrThrow(),
})

// Switch file tree root when git connects/disconnects
gitService.subscribeStatus(async (status) => {
  try {
    if (status.isConnected) {
      await fileSystemWatcher.setScanRoot(GIT_ROOT)
    } else {
      await fileSystemWatcher.resetScanRoot()
    }
  } catch {
    // File-manager initialization presents storage failures with a retry action.
    // Status listeners must not turn them into unhandled promise rejections.
  }
})

// Re-export types from package
export type {
  GitConfig,
  GitStatus,
  FileChange,
  FileItem,
  GitStatusListener,
  FileTreeListener
} from '@siglum/git'

export default gitService
