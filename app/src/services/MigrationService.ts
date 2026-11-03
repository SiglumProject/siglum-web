/**
 * MigrationService - Migrates documents from old /documents/{id}.tex to /project/{name}.tex
 *
 * This is a one-time migration that runs on first initialization of the new unified
 * filesystem architecture.
 *
 * Migration process:
 * 1. Check if migration has already been done (localStorage flag)
 * 2. Check if /documents/ exists and has files
 * 3. Create /project/ directory
 * 4. For each document:
 *    - Read content from /documents/{id}.tex
 *    - Read metadata from /documents/{id}.meta.json (for title)
 *    - Create file at /project/{title}.tex (sanitized)
 * 5. Keep /documents/ for safety (user can delete later)
 * 6. Mark migration complete
 */

import { fileSystem } from '@siglum/filesystem'

const MIGRATION_KEY = 'siglum_unified_fs_migration_v1'
const OLD_DOCUMENTS_PATH = '/documents'
const MOUNT_POINT = '/project'
const PROJECT_PATH = '/project/src'

interface SerializedMetadata {
  id: string
  filePath: string
  title: string
  createdAt: string
  updatedAt: string
  lastViewedAt: string
  wordCount: number
}

class MigrationService {
  private migrated = false

  /**
   * Run migration if needed
   * Returns true if migration was performed, false if already done or not needed
   */
  async migrateIfNeeded(): Promise<boolean> {
    if (this.migrated) return false

    // Check if migration was already done
    if (localStorage.getItem(MIGRATION_KEY) === 'complete') {
      this.migrated = true
      return false
    }

    // Mount both directories if not already mounted
    if (!fileSystem.isMounted(OLD_DOCUMENTS_PATH)) {
      try {
        await fileSystem.mountAuto(OLD_DOCUMENTS_PATH)
      } catch {
        // Old documents path might not exist
      }
    }

    if (!fileSystem.isMounted(MOUNT_POINT)) {
      await fileSystem.mountAuto(MOUNT_POINT)
    }

    // Check if old documents exist
    const hasOldDocs = await this.hasOldDocuments()
    const hasNewProject = await fileSystem.exists(PROJECT_PATH)

    if (!hasOldDocs) {
      // No old documents to migrate
      // Just ensure project directory exists
      if (!hasNewProject) {
        try {
          await fileSystem.mkdir(PROJECT_PATH, { silent: true })
        } catch {
          // Directory might already exist
        }
      }
      localStorage.setItem(MIGRATION_KEY, 'complete')
      this.migrated = true
      return false
    }

    // Create project directory if it doesn't exist
    if (!hasNewProject) {
      await fileSystem.mkdir(PROJECT_PATH, { silent: true })
    }

    // Run migration
    await this.migrateDocuments()

    localStorage.setItem(MIGRATION_KEY, 'complete')
    this.migrated = true
    console.log('[MigrationService] Migration complete')
    return true
  }

  /**
   * Check if old documents directory has files
   */
  private async hasOldDocuments(): Promise<boolean> {
    try {
      const entries = await fileSystem.readdir(OLD_DOCUMENTS_PATH)
      return entries.some(e => e.name.endsWith('.tex'))
    } catch {
      return false
    }
  }

  /**
   * Migrate all documents from old format to new format
   */
  private async migrateDocuments(): Promise<void> {
    console.log('[MigrationService] Starting migration from /documents/ to /project/')

    try {
      const entries = await fileSystem.readdir(OLD_DOCUMENTS_PATH)
      const texFiles = entries.filter(e => e.name.endsWith('.tex'))

      let migratedCount = 0
      const usedNames = new Set<string>()

      for (const entry of texFiles) {
        const id = entry.name.replace('.tex', '')
        const oldTexPath = `${OLD_DOCUMENTS_PATH}/${entry.name}`
        const oldMetaPath = `${OLD_DOCUMENTS_PATH}/${id}.meta.json`

        try {
          // Read content
          const content = await fileSystem.readFile(oldTexPath)

          // Try to get title from metadata
          let title = 'Untitled'
          try {
            const metaContent = await fileSystem.readFile(oldMetaPath)
            const metadata: SerializedMetadata = JSON.parse(metaContent)
            if (metadata.title) {
              title = metadata.title
            }
          } catch {
            // Try to extract title from content
            title = this.extractTitleFromContent(content) || 'Untitled'
          }

          // Sanitize title for filename
          let fileName = this.sanitizeFileName(title)
          if (!fileName.endsWith('.tex')) {
            fileName += '.tex'
          }

          // Ensure unique name
          let uniqueName = fileName
          let counter = 1
          while (usedNames.has(uniqueName.toLowerCase())) {
            const base = fileName.replace('.tex', '')
            uniqueName = `${base}-${counter}.tex`
            counter++
          }
          usedNames.add(uniqueName.toLowerCase())

          // Write to new location
          const newPath = `${PROJECT_PATH}/${uniqueName}`
          await fileSystem.writeFile(newPath, content, { createParents: true, silent: true })

          migratedCount++
          console.log(`[MigrationService] Migrated: ${id} -> ${uniqueName}`)
        } catch (err) {
          console.warn(`[MigrationService] Failed to migrate ${entry.name}:`, err)
        }
      }

      console.log(`[MigrationService] Migrated ${migratedCount} documents`)
    } catch (err) {
      console.error('[MigrationService] Migration error:', err)
      throw err
    }
  }

  /**
   * Extract title from LaTeX content
   */
  private extractTitleFromContent(content: string): string | null {
    // Try \title{...}
    const titleMatch = content.match(/\\title\s*\{([^}]+)\}/)
    if (titleMatch) {
      return titleMatch[1].trim()
    }

    // Try first section
    const sectionMatch = content.match(/\\(?:section|chapter)\*?\s*\{([^}]+)\}/)
    if (sectionMatch) {
      return sectionMatch[1].trim()
    }

    // Try first line that looks like a title (not a command)
    const lines = content.split('\n')
    for (const line of lines.slice(0, 20)) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('\\') && !trimmed.startsWith('%') && trimmed.length > 3 && trimmed.length < 100) {
        return trimmed
      }
    }

    return null
  }

  /**
   * Sanitize a string for use as a filename
   */
  private sanitizeFileName(name: string): string {
    // Remove or replace invalid characters
    let sanitized = name
      .replace(/[<>:"/\\|?*]/g, '-')  // Invalid on Windows
      .replace(/[\x00-\x1f\x7f]/g, '') // Control characters
      .replace(/\.{2,}/g, '.')         // Multiple dots
      .replace(/\s+/g, ' ')            // Multiple spaces to single space
      .trim()

    // Remove leading/trailing dots and spaces
    sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '')

    // Limit length
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100)
    }

    // Fallback if empty
    if (!sanitized) {
      sanitized = 'untitled'
    }

    return sanitized
  }

  /**
   * Check if migration has been completed
   */
  isMigrationComplete(): boolean {
    return localStorage.getItem(MIGRATION_KEY) === 'complete'
  }

  /**
   * Force re-migration (for testing)
   */
  resetMigration(): void {
    localStorage.removeItem(MIGRATION_KEY)
    this.migrated = false
  }
}

// Export singleton
export const migrationService = new MigrationService()
export default migrationService
