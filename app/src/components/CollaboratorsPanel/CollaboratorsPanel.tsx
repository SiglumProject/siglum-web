import React, { useState, useEffect, useCallback } from 'react'
import { Check, RefreshCw, ExternalLink, HelpCircle, X, Plus } from 'lucide-react'
import GitService from '../../services/GitService'
import './CollaboratorsPanel.css'

// Types for collaborative editing
interface Collaborator {
  username: string
  branch: string
  lastActivity?: Date
  lastCommit?: string
  isCurrentUser: boolean
  presence?: CollaboratorPresence
}

interface CollaboratorPresence {
  currentFile?: string
  cursorLine?: number
  lastSeen: Date
  status: 'active' | 'idle' | 'away'
}

interface BranchDiff {
  myOnly: string[]
  theirOnly: string[]
  conflicting: string[]
  theirModified: string[]
}

// Type for extended GitService with collaboration methods
type CollabGitService = {
  isCollaborativeMode?: () => boolean
  subscribeCollaborators?: (cb: (collaborators: Collaborator[]) => void) => () => void
  startCollaborativeEditing?: () => Promise<void>
  mergeFromCollaborator?: (branch: string, files?: string[]) => Promise<void>
  publishDraft?: (title: string, body: string) => Promise<{ prUrl: string } | null>
  getCollaboratorDiff?: (branch: string) => Promise<BranchDiff>
  getConfig: () => { branch?: string; username?: string; repoUrl?: string } | null
  subscribeStatus: (cb: () => void) => () => void
}

interface CollaboratorAvatarProps {
  collaborator: Collaborator
  onClick: () => void
  isSelected: boolean
}

const CollaboratorAvatar: React.FC<CollaboratorAvatarProps> = ({ collaborator, onClick, isSelected }) => {
  const getPresenceStatus = () => {
    if (!collaborator.presence) return 'offline'
    const lastSeen = new Date(collaborator.presence.lastSeen)
    const minutesAgo = (Date.now() - lastSeen.getTime()) / 60000
    if (minutesAgo < 2) return 'active'
    if (minutesAgo < 10) return 'idle'
    return 'away'
  }

  const status = getPresenceStatus()
  const initial = collaborator.username.charAt(0).toUpperCase()

  return (
    <button
      className={`collab-avatar ${status} ${isSelected ? 'selected' : ''} ${collaborator.isCurrentUser ? 'you' : ''}`}
      onClick={onClick}
      title={collaborator.isCurrentUser ? `${collaborator.username} (you)` : collaborator.username}
    >
      <span className="collab-avatar-initial">{initial}</span>
      {collaborator.presence?.currentFile && !collaborator.isCurrentUser && (
        <span className="collab-avatar-editing" />
      )}
    </button>
  )
}

interface CollaboratorDetailProps {
  collaborator: Collaborator
  onClose: () => void
  onAddChanges: (files: string[]) => void
}

const CollaboratorDetail: React.FC<CollaboratorDetailProps> = ({ collaborator, onClose, onAddChanges }) => {
  const [diff, setDiff] = useState<BranchDiff | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadDiff = async () => {
      const gitSvc = GitService as unknown as CollabGitService
      if (gitSvc.getCollaboratorDiff) {
        try {
          const d = await gitSvc.getCollaboratorDiff(collaborator.branch)
          setDiff(d)
        } catch (e) {
          console.error('Failed to load changes:', e)
        }
      }
      setIsLoading(false)
    }
    loadDiff()
  }, [collaborator.branch])

  const totalChanges = diff ? diff.theirOnly.length + diff.theirModified.length : 0
  const hasConflicts = diff && diff.conflicting.length > 0

  return (
    <div className="collab-detail">
      <div className="collab-detail-header">
        <div className="collab-detail-user">
          <span className="collab-detail-name">{collaborator.username}</span>
          {collaborator.presence?.currentFile && (
            <span className="collab-detail-status">
              editing {collaborator.presence.currentFile.split('/').pop()}
            </span>
          )}
        </div>
        <button className="collab-detail-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {isLoading ? (
        <div className="collab-detail-loading">
          <RefreshCw size={14} className="spin" />
        </div>
      ) : totalChanges === 0 ? (
        <div className="collab-detail-empty">
          <Check size={14} />
          <span>You're in sync</span>
        </div>
      ) : (
        <div className="collab-detail-changes">
          <p className="collab-detail-summary">
            {totalChanges} {totalChanges === 1 ? 'change' : 'changes'} you don't have
          </p>

          {diff && diff.theirOnly.length > 0 && (
            <div className="collab-change-group">
              <span className="collab-change-label">New files</span>
              <ul>
                {diff.theirOnly.slice(0, 3).map((f: string) => (
                  <li key={f}>{f.split('/').pop()}</li>
                ))}
                {diff.theirOnly.length > 3 && (
                  <li className="collab-change-more">+{diff.theirOnly.length - 3} more</li>
                )}
              </ul>
            </div>
          )}

          {diff && diff.theirModified.length > 0 && (
            <div className="collab-change-group">
              <span className="collab-change-label">Modified</span>
              <ul>
                {diff.theirModified.slice(0, 3).map((f: string) => (
                  <li key={f}>{f.split('/').pop()}</li>
                ))}
                {diff.theirModified.length > 3 && (
                  <li className="collab-change-more">+{diff.theirModified.length - 3} more</li>
                )}
              </ul>
            </div>
          )}

          {hasConflicts && (
            <p className="collab-detail-conflict">
              {diff!.conflicting.length} file{diff!.conflicting.length > 1 ? 's' : ''} you both edited
            </p>
          )}

          <button
            className="collab-add-btn"
            onClick={() => onAddChanges([...(diff?.theirOnly || []), ...(diff?.theirModified || [])])}
            disabled={!!hasConflicts}
          >
            <Plus size={14} />
            Add to your version
          </button>
        </div>
      )}
    </div>
  )
}

const CollaboratorsBar: React.FC = () => {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [selectedCollab, setSelectedCollab] = useState<Collaborator | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [shareTitle, setShareTitle] = useState('')
  const [isSharing, setIsSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)

  const gitSvc = GitService as unknown as CollabGitService
  const isCollabMode = gitSvc.isCollaborativeMode?.() ?? false

  // Auto-initialize collaboration when connected to git
  useEffect(() => {
    const initCollab = async () => {
      const config = gitSvc.getConfig()
      if (!config || isCollabMode) return

      // Check if startCollaborativeEditing exists
      if (typeof (GitService as any).startCollaborativeEditing !== 'function') return

      setIsInitializing(true)
      try {
        await (GitService as any).startCollaborativeEditing()
      } catch (e) {
        console.error('Failed to initialize collaboration:', e)
      } finally {
        setIsInitializing(false)
      }
    }

    initCollab()
  }, [gitSvc, isCollabMode])

  // Subscribe to collaborators
  useEffect(() => {
    if (!gitSvc.subscribeCollaborators) return
    const unsubscribe = gitSvc.subscribeCollaborators(setCollaborators)
    return unsubscribe
  }, [gitSvc])

  const handleAddChanges = useCallback(async (files: string[]) => {
    if (!selectedCollab || !gitSvc.mergeFromCollaborator) return
    try {
      await gitSvc.mergeFromCollaborator(selectedCollab.branch, files)
      setSelectedCollab(null)
    } catch (e) {
      console.error('Failed to add changes:', e)
    }
  }, [selectedCollab, gitSvc])

  const handleShare = useCallback(async () => {
    if (!shareTitle.trim() || !gitSvc.publishDraft) return
    setIsSharing(true)
    try {
      const result = await gitSvc.publishDraft(shareTitle, '')
      if (result) {
        setShareUrl(result.prUrl)
      }
    } catch (e) {
      console.error('Failed to share:', e)
    } finally {
      setIsSharing(false)
    }
  }, [shareTitle, gitSvc])

  // Don't show anything if not connected to git
  const config = gitSvc.getConfig()
  if (!config) return null

  // Show loading state while initializing
  if (isInitializing) {
    return (
      <div className="collab-bar">
        <RefreshCw size={14} className="spin collab-bar-loading" />
      </div>
    )
  }

  const otherCollaborators = collaborators.filter(c => !c.isCurrentUser)
  const currentUser = collaborators.find(c => c.isCurrentUser)

  return (
    <div className="collab-bar">
      {/* Collaborator avatars */}
      <div className="collab-avatars">
        {currentUser && (
          <CollaboratorAvatar
            key={currentUser.branch}
            collaborator={currentUser}
            onClick={() => {}}
            isSelected={false}
          />
        )}
        {otherCollaborators.map(collab => (
          <CollaboratorAvatar
            key={collab.branch}
            collaborator={collab}
            onClick={() => setSelectedCollab(selectedCollab?.branch === collab.branch ? null : collab)}
            isSelected={selectedCollab?.branch === collab.branch}
          />
        ))}
      </div>

      {/* Help button */}
      <button className="collab-help-btn" onClick={() => setShowHelp(!showHelp)}>
        <HelpCircle size={14} />
      </button>

      {/* Selected collaborator detail popup */}
      {selectedCollab && (
        <CollaboratorDetail
          collaborator={selectedCollab}
          onClose={() => setSelectedCollab(null)}
          onAddChanges={handleAddChanges}
        />
      )}

      {/* Help popup */}
      {showHelp && (
        <div className="collab-help-popup">
          <button className="collab-help-close" onClick={() => setShowHelp(false)}>
            <X size={14} />
          </button>
          <h4>Focus-first collaboration</h4>
          <p>
            Unlike real-time editors where you see every keystroke, Siglum lets you
            <strong> work without distraction</strong>. Each person has their own
            private workspace.
          </p>
          <p>
            When you're ready, click someone's avatar to see what they've changed.
            Add their changes to your version with one click.
          </p>
          <p>
            When your work is ready to share with everyone, click <strong>Share</strong>.
          </p>
          <div className="collab-help-faq">
            <h5>Why not real-time?</h5>
            <p>
              Writing requires focus. Seeing cursors jumping around and text appearing
              mid-thought breaks your flow. This way, you write in peace and
              collaborate when you choose to.
            </p>
          </div>
        </div>
      )}

      {/* Share modal */}
      {showShare && (
        <div className="collab-modal-overlay" onClick={() => !isSharing && setShowShare(false)}>
          <div className="collab-modal" onClick={e => e.stopPropagation()}>
            {shareUrl ? (
              <div className="collab-share-success">
                <Check size={24} />
                <h3>Shared!</h3>
                <p>Your changes are ready for review.</p>
                <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                  View on GitHub <ExternalLink size={12} />
                </a>
                <button onClick={() => { setShowShare(false); setShareUrl(null); setShareTitle('') }}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <h3>Share your changes</h3>
                <p>Describe what you worked on:</p>
                <input
                  type="text"
                  placeholder="e.g., Added introduction and fixed typos"
                  value={shareTitle}
                  onChange={e => setShareTitle(e.target.value)}
                  autoFocus
                />
                <div className="collab-modal-actions">
                  <button className="collab-modal-cancel" onClick={() => setShowShare(false)}>
                    Cancel
                  </button>
                  <button
                    className="collab-modal-share"
                    onClick={handleShare}
                    disabled={!shareTitle.trim() || isSharing}
                  >
                    {isSharing ? <RefreshCw size={14} className="spin" /> : 'Share'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default CollaboratorsBar
