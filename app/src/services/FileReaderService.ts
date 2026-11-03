/**
 * FileReaderService - Unified file reading with Git/local fallback
 *
 * Provides a single API for reading project files, using canonical mounted paths with a legacy Git fallback.
 */

import GitService from './GitService'
import { fileSystem } from '@siglum/filesystem'

class FileReaderService {
  async readBinary(path: string): Promise<Uint8Array | null> {
    try { return await fileSystem.readBinary(path) } catch { return null }
  }

  /**
   * Read a file from its mounted project path.
   */
  async readFile(path: string): Promise<string | null> {
    // ProjectStore provides canonical mounted paths (/project/... or /git/...).
    // Read these directly so the Git adapter cannot add a second /git prefix.
    try {
      return await fileSystem.readFile(path)
    } catch {
      // Older callers may still provide paths relative to the Git root.
      if (GitService.getStatus().isConnected && !/^\/(?:project|git)(?:\/|$)/.test(path)) {
        try { return await GitService.readFile(path) } catch { /* missing file */ }
      }
      return null
    }
  }
}

export default new FileReaderService()
