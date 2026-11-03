import React, { useState } from 'react'
import BaseModal from './BaseModal'
import {
  FileText,
  MessageCircle,
  LifeBuoy,
  Bug,
  Github,
  ArrowRight,
  ArrowLeft,
  Check,
  RefreshCw,
  Plug,
  Users,
  Share2,
  MoveLeft,
  MoveRight,
  Menu,
  Play,
  Search
} from 'lucide-react'
import ZoteroIcon from './icons/ZoteroIcon'
import GitService, { type GitStatus, type GitConfig } from '../services/GitService'
import CitationService, { type ZoteroStatus } from '../services/CitationService'
import { useIsMobile } from '../hooks/useIsMobile'
import './DocumentationModal.css'

interface DocumentationModalProps {
  isOpen: boolean
  isClosing?: boolean
  onClose: () => void
  onBack?: () => void
  defaultTab?: TabId
}

type TabId = 'guide' | 'collaboration' | 'sharing' | 'integrations' | 'faq' | 'support'

interface Tab {
  id: TabId
  label: string
  icon: React.ReactNode
}

const tabs: Tab[] = [
  { id: 'guide', label: 'Getting Started', icon: <FileText size={16} /> },
  { id: 'collaboration', label: 'Collaboration', icon: <Users size={16} /> },
  { id: 'sharing', label: 'Sharing', icon: <Share2 size={16} /> },
  { id: 'integrations', label: 'Integrations', icon: <Plug size={16} /> },
  { id: 'faq', label: 'FAQ', icon: <MessageCircle size={16} /> },
  { id: 'support', label: 'Support', icon: <LifeBuoy size={16} /> }
]

const DocumentationModal: React.FC<DocumentationModalProps> = ({ isOpen, isClosing = false, onClose, onBack, defaultTab = 'guide' }) => {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab)
  const [selectedIntegration, setSelectedIntegration] = useState<string | null>(null)
  const isMobile = useIsMobile()

  // Git state
  const [gitStatus, setGitStatus] = useState<GitStatus>(GitService.getStatus())
  const [gitConfig, setGitConfig] = useState<Partial<GitConfig>>(() => GitService.getConfig() || {
    provider: 'github',
    repoUrl: '',
    branch: 'main',
    token: '',
    syncInterval: '15min'
  })
  const [isGitConnecting, setIsGitConnecting] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)

  // Zotero state
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus>(CitationService.getZoteroStatus())
  const [zoteroUserId, setZoteroUserId] = useState('')
  const [zoteroApiKey, setZoteroApiKey] = useState('')
  const [isZoteroConnecting, setIsZoteroConnecting] = useState(false)

  // Subscribe to status updates
  React.useEffect(() => {
    const unsubGit = GitService.subscribeStatus(setGitStatus)
    const unsubZotero = CitationService.onStatus((status) => setZoteroStatus(status.zotero))
    return () => {
      unsubGit()
      unsubZotero()
    }
  }, [])

  // Update active tab when defaultTab changes (e.g., opening from different links)
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(defaultTab)
    }
  }, [isOpen, defaultTab])

  // Git handlers
  const handleGitConnect = async () => {
    if (!gitConfig.repoUrl?.trim() || !gitConfig.token?.trim()) return
    setIsGitConnecting(true)
    setGitError(null)
    try {
      await GitService.connect(gitConfig as GitConfig)
    } catch (e) {
      setGitError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setIsGitConnecting(false)
    }
  }

  const handleGitDisconnect = async () => {
    await GitService.disconnect()
    setGitConfig({ provider: 'github', repoUrl: '', branch: 'main', token: '', syncInterval: '15min' })
  }

  const handleGitSync = async () => {
    try {
      await GitService.sync()
    } catch (e) {
      console.error('Git sync failed:', e)
    }
  }

  // Zotero handlers
  const handleZoteroConnect = async () => {
    if (!zoteroUserId.trim() || !zoteroApiKey.trim()) return
    setIsZoteroConnecting(true)
    try {
      await CitationService.connectZotero(zoteroUserId.trim(), zoteroApiKey.trim())
      setZoteroUserId('')
      setZoteroApiKey('')
    } catch (e) {
      console.error('Zotero connect failed:', e)
    } finally {
      setIsZoteroConnecting(false)
    }
  }

  const handleZoteroDisconnect = async () => {
    await CitationService.disconnectZotero()
  }

  const handleZoteroSync = async () => {
    try {
      await CitationService.syncZotero()
    } catch (e) {
      console.error('Zotero sync failed:', e)
    }
  }

  const backButton = onBack ? (
    <button
      onClick={onBack}
      style={{
        background: 'rgba(255, 255, 255, 0.08)',
        border: 'none',
        borderRadius: '8px',
        padding: '6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255, 255, 255, 0.7)',
        transition: 'all 0.15s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'
        e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'
        e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)'
      }}
      aria-label="Go back"
    >
      <ArrowLeft size={18} />
    </button>
  ) : null

  const renderContent = () => {
    switch (activeTab) {
      case 'guide':
        return (
          <div className="doc-content">
            {isMobile ? (
              <>
                <h2>Getting Around</h2>
                <p className="doc-lead">How to navigate on your phone or tablet.</p>

                <div className="shortcuts-group">
                  <h3>Navigation</h3>
                  <div className="gesture-list">
                    <div className="gesture-item">
                      <div className="gesture-icon"><MoveLeft size={20} aria-hidden="true" /></div>
                      <div className="gesture-text">
                        <strong>Tap Preview, or hold to peek</strong>
                        <span>Hold to see the PDF near your cursor. Release to keep writing in the same place.</span>
                      </div>
                    </div>
                    <div className="gesture-item">
                      <div className="gesture-icon"><MoveRight size={20} aria-hidden="true" /></div>
                      <div className="gesture-text">
                        <strong>Tap Source</strong>
                        <span>Return from the full PDF to your editor.</span>
                      </div>
                    </div>
                    <div className="gesture-item">
                      <div className="gesture-icon"><Menu size={20} aria-hidden="true" /></div>
                      <div className="gesture-text">
                        <strong>Tap hamburger menu</strong>
                        <span>Open sidebar for files & settings</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="shortcuts-group">
                  <h3>Quick Actions</h3>
                  <div className="gesture-list">
                    <div className="gesture-item">
                      <div className="gesture-icon"><Play size={20} aria-hidden="true" /></div>
                      <div className="gesture-text">
                        <strong>Tap compile button</strong>
                        <span>Build your PDF</span>
                      </div>
                    </div>
                    <div className="gesture-item">
                      <div className="gesture-icon"><Search size={20} aria-hidden="true" /></div>
                      <div className="gesture-text">
                        <strong>Tap search icon</strong>
                        <span>Open command palette</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="shortcuts-group">
                  <h3>Writing on your phone</h3>
                  <p>Tap More or drag upward from the dock to reveal labeled tools. Insert builds equations, tables, images, citations, and headings with live examples and editable LaTeX.</p>
                  <p>Open the PDF lens from More to keep a small preview beside your source. Drag its handle to move it; expand it for the full page.</p>
                  <p>Compile errors appear as cards with a source excerpt. Go there moves to the problem, Next error steps through the list, and Full log opens the complete compiler output.</p>
                </div>

                <p className="doc-note">The strip above the dock follows your cursor: math tools in equations, bibliography keys in citations, and project files in filename arguments.</p>
              </>
            ) : (
              <>
                <h2>Shortcuts</h2>
                <p className="doc-lead">The keyboard shortcuts worth memorizing.</p>

                <div className="shortcuts-group">
                  <h3>Navigation</h3>
                  <div className="shortcut-list">
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>K</kbd>
                      </div>
                      <span>Open command palette (this is the big one)</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>S</kbd>
                      </div>
                      <span>Compile document</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>⇧</kbd><kbd>↵</kbd>
                      </div>
                      <span>Jump to next section (wraps around)</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>N</kbd>
                      </div>
                      <span>New document</span>
                    </div>
                  </div>
                </div>

                <div className="shortcuts-group">
                  <h3>Layout</h3>
                  <div className="shortcut-list">
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>1</kbd>
                      </div>
                      <span>Editor only</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>2</kbd>
                      </div>
                      <span>Editor + PDF side by side</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>\\</kbd>
                      </div>
                      <span>Toggle PDF preview</span>
                    </div>
                  </div>
                </div>

                <div className="shortcuts-group">
                  <h3>Formatting</h3>
                  <div className="shortcut-list">
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>B</kbd>
                      </div>
                      <span>Wrap in \textbf{"{"}...{"}"}</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>I</kbd>
                      </div>
                      <span>Wrap in \textit{"{"}...{"}"}</span>
                    </div>
                    <div className="shortcut-item">
                      <div className="shortcut-keys">
                        <kbd>⌘</kbd><kbd>⇧</kbd><kbd>M</kbd>
                      </div>
                      <span>Wrap in $...$</span>
                    </div>
                  </div>
                </div>

                <p className="doc-note">On Windows/Linux, use Ctrl instead of ⌘</p>
              </>
            )}
          </div>
        )

      case 'collaboration':
        return (
          <div className="doc-content">
            <h2>Working Together</h2>
            <p className="doc-lead">
              Siglum uses GitHub for collaboration. Each person works independently
              and changes sync automatically through Git.
            </p>

            <div className="collab-section">
              <h3>How it works</h3>
              <p>
                Unlike real-time editors where you see every keystroke, Siglum lets you
                focus without distraction. You work at your own pace and sync changes
                when you're ready.
              </p>
              <ol className="collab-steps">
                <li><strong>Connect GitHub</strong> by linking a repository in Integrations</li>
                <li><strong>Work independently</strong> and edit without interruption</li>
                <li><strong>Sync when ready</strong> to push your changes and pull others'</li>
              </ol>
            </div>

            <div className="collab-section">
              <h3>Avoiding conflicts</h3>
              <p>
                Git tracks changes line-by-line, so conflicts happen when two people
                edit the same lines. A few habits that help:
              </p>
              <ul className="collab-tips">
                <li>
                  <strong>Split into sections early.</strong> Create separate files for
                  chapters or sections before you start writing so each person can work
                  in different files.
                </li>
                <li>
                  <strong>Use <code>\input{'{'}file{'}'}</code></strong> to include section
                  files in your main document. Edits to different sections won't conflict.
                </li>
                <li>
                  <strong>Sync often.</strong> Small, frequent syncs are easier to merge
                  than large batches of changes.
                </li>
                <li>
                  <strong>Communicate.</strong> A quick message about which section you're
                  working on goes a long way.
                </li>
              </ul>
            </div>

            <div className="collab-section">
              <h3>What Siglum handles</h3>
              <div className="collab-comparison">
                <div className="collab-column">
                  <h4>Siglum</h4>
                  <ul>
                    <li>LaTeX editing and compilation</li>
                    <li>File management</li>
                    <li>Syncing with GitHub</li>
                    <li>Conflict detection</li>
                  </ul>
                </div>
                <div className="collab-column">
                  <h4>GitHub</h4>
                  <ul>
                    <li>Version history</li>
                    <li>Branch management</li>
                    <li>Access control</li>
                    <li>Diff viewing</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="collab-section">
              <h3>Sharing citations</h3>
              <p>
                When you insert a citation, the BibTeX entry is added to
                your <code>references.bib</code> file. This syncs through GitHub like
                everything else, so all collaborators share the same bibliography.
              </p>
            </div>
          </div>
        )

      case 'sharing':
        return (
          <div className="doc-content">
            <h2>Getting Feedback</h2>
            <p className="doc-lead">
              We're building a way to share your PDF for comments. Coming soon.
            </p>

            <div className="collab-section">
              <h3>How it will work</h3>
              <p>
                You'll be able to create a snapshot of your PDF and share a link with
                your advisor, collaborator, or anyone who needs to review it. They'll
                be able to leave comments directly on the document.
              </p>
            </div>

            <div className="collab-section">
              <h3>Your source stays private</h3>
              <p>
                Sharing will only upload a PDF snapshot for reviewers to see. Your
                source files will never leave your browser.
              </p>
            </div>

            <div className="collab-section">
              <h3>For now: use GitHub</h3>
              <p>
                Until sharing is ready, you can collaborate through GitHub. Connect
                a repository and anyone with access can work on the same project.
              </p>
            </div>
          </div>
        )

      case 'integrations':
        return (
          <div className="doc-content integrations-split">
            <div className="integrations-nav">
              <button
                className={`integrations-nav-btn ${selectedIntegration === 'github' || !selectedIntegration ? 'active' : ''}`}
                onClick={() => setSelectedIntegration('github')}
              >
                <Github size={16} />
                <span>GitHub</span>
                {gitStatus.isConnected && <span className="integrations-nav-dot" />}
              </button>
              <button
                className={`integrations-nav-btn ${selectedIntegration === 'zotero' ? 'active' : ''}`}
                onClick={() => setSelectedIntegration('zotero')}
              >
                <ZoteroIcon size={16} />
                <span>Zotero</span>
                {zoteroStatus.connected && <span className="integrations-nav-dot" />}
              </button>
              <a
                href="https://github.com/SiglumProject/siglum-web/issues/new?labels=integration&title=Integration%20suggestion:"
                target="_blank"
                rel="noopener noreferrer"
                className="integrations-suggest-link"
              >
                Suggest an integration
              </a>
            </div>

            <div className="integrations-content">
              {(selectedIntegration === 'github' || !selectedIntegration) && (
                <>
                  <div className="integration-header">
                    <Github size={24} />
                    <h2>GitHub</h2>
                  </div>
                  <p className="doc-lead">Sync your documents to a Git repository for version control and backup.</p>

                  {gitStatus.isConnected ? (
                    <>
                      <div className="integration-status-banner connected">
                        <Check size={14} />
                        <span>Connected</span>
                      </div>

                      <div className="integration-fields">
                        <div className="integration-field">
                          <label>Repository</label>
                          <div className="integration-field-value">{gitConfig.repoUrl}</div>
                        </div>
                        <div className="integration-field">
                          <label>Branch</label>
                          <div className="integration-field-value editable">
                            <input
                              type="text"
                              value={gitConfig.branch || ''}
                              onChange={(e) => setGitConfig({ ...gitConfig, branch: e.target.value })}
                              onBlur={() => {
                                if (gitConfig.branch) {
                                  GitService.setBranch(gitConfig.branch)
                                }
                              }}
                              className="branch-input"
                            />
                          </div>
                        </div>
                        {gitStatus.lastSync && (
                          <div className="integration-field">
                            <label>Last synced</label>
                            <div className="integration-field-value">
                              {new Date(gitStatus.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="integration-actions">
                        <button
                          className="integration-action-btn primary"
                          onClick={handleGitSync}
                          disabled={gitStatus.isSyncing}
                        >
                          <RefreshCw size={14} className={gitStatus.isSyncing ? 'spinning' : ''} />
                          {gitStatus.isSyncing ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <button className="integration-action-btn secondary" onClick={handleGitDisconnect}>
                          Disconnect
                        </button>
                      </div>

                      <div className="integration-feature-section">
                        <h4>Collaboration</h4>
                        <p>
                          Anyone with access to this repository can collaborate. Each person gets their own
                          branch automatically. Changes sync in the background.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="integration-form">
                        <div className="integration-field">
                          <label>Repository</label>
                          <input
                            type="text"
                            placeholder="username/repository"
                            value={gitConfig.repoUrl || ''}
                            onChange={(e) => setGitConfig({ ...gitConfig, repoUrl: e.target.value })}
                          />
                        </div>
                        <div className="integration-field">
                          <label>Personal Access Token</label>
                          <input
                            type="password"
                            placeholder="ghp_xxxxxxxxxxxx"
                            value={gitConfig.token || ''}
                            onChange={(e) => setGitConfig({ ...gitConfig, token: e.target.value })}
                          />
                          <a
                            href="https://github.com/settings/tokens/new?scopes=repo&description=Siglum"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="integration-field-help"
                          >
                            Create a token on GitHub →
                          </a>
                        </div>
                        {gitError && <p className="integration-form-error">{gitError}</p>}
                        <div className="integration-actions">
                          <button
                            className="integration-action-btn primary"
                            onClick={handleGitConnect}
                            disabled={!gitConfig.repoUrl?.trim() || !gitConfig.token?.trim() || isGitConnecting}
                          >
                            {isGitConnecting ? 'Connecting...' : 'Connect'}
                          </button>
                        </div>
                      </div>

                      <div className="integration-feature-section">
                        <h4>Includes collaboration</h4>
                        <p>
                          Connect a repository and anyone with access can collaborate. Each person gets
                          their own branch automatically.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}

              {selectedIntegration === 'zotero' && (
                <>
                  <div className="integration-header">
                    <ZoteroIcon size={24} />
                    <h2>Zotero</h2>
                  </div>
                  <p className="doc-lead">Import citations from your Zotero library into the shared bibliography.</p>

                  {zoteroStatus.connected ? (
                    <>
                      <div className="integration-status-banner connected">
                        <Check size={14} />
                        <span>Connected</span>
                      </div>

                      <div className="integration-fields">
                        <div className="integration-field">
                          <label>User ID</label>
                          <div className="integration-field-value">{zoteroStatus.userId}</div>
                        </div>
                        <div className="integration-field">
                          <label>Library</label>
                          <div className="integration-field-value">{zoteroStatus.itemCount} items cached</div>
                        </div>
                      </div>

                      <div className="integration-actions">
                        <button
                          className="integration-action-btn primary"
                          onClick={handleZoteroSync}
                          disabled={zoteroStatus.syncing}
                        >
                          <RefreshCw size={14} className={zoteroStatus.syncing ? 'spinning' : ''} />
                          {zoteroStatus.syncing ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <button className="integration-action-btn secondary" onClick={handleZoteroDisconnect}>
                          Disconnect
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="integration-form">
                      <div className="integration-field">
                        <label>User ID</label>
                        <input
                          type="text"
                          placeholder="Your Zotero user ID"
                          value={zoteroUserId}
                          onChange={(e) => setZoteroUserId(e.target.value)}
                        />
                        <span className="integration-field-hint">Find this in Zotero settings under "Feeds/API"</span>
                      </div>
                      <div className="integration-field">
                        <label>API Key</label>
                        <input
                          type="password"
                          placeholder="Your Zotero API key"
                          value={zoteroApiKey}
                          onChange={(e) => setZoteroApiKey(e.target.value)}
                        />
                        <a
                          href="https://www.zotero.org/settings/keys/new"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="integration-field-help"
                        >
                          Create an API key on Zotero →
                        </a>
                      </div>
                      <div className="integration-actions">
                        <button
                          className="integration-action-btn primary"
                          onClick={handleZoteroConnect}
                          disabled={!zoteroUserId.trim() || !zoteroApiKey.trim() || isZoteroConnecting}
                        >
                          {isZoteroConnecting ? 'Connecting...' : 'Connect'}
                        </button>
                      </div>

                      <div className="integration-feature-section">
                        <h4>How it works</h4>
                        <p>
                          When you insert a citation, the BibTeX entry is added to references.bib
                          automatically. If you're using GitHub, this file is shared with collaborators.
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )

      case 'faq':
        return (
          <div className="doc-content">
            <h2>FAQ</h2>
            <p className="doc-lead">Questions people sometimes ask.</p>

            <div className="faq-list">
              <details className="faq-item">
                <summary>Do you store my documents on your server?</summary>
                <p>
                  No. Your source files stay in your browser and never touch our servers.
                  Compilation happens locally on your machine. We're working on a sharing
                  feature that will let you send a PDF snapshot for feedback, but even
                  then your source files will remain local.
                </p>
              </details>

              <details className="faq-item">
                <summary>Is my work saved?</summary>
                <p>
                  Yes, automatically. Everything saves to your browser's local storage,
                  and if you've connected GitHub it will sync there too.
                </p>
              </details>

              <details className="faq-item">
                <summary>Can I use [obscure package]?</summary>
                <p>
                  Probably. We bundle the most common packages, and anything else gets
                  fetched from CTAN automatically the first time you use it.
                </p>
              </details>

              <details className="faq-item">
                <summary>Can I use custom fonts?</summary>
                <p>
                  Yes. Drop a .ttf or .otf file in your project and use fontspec. We
                  include Latin Modern, TeX Gyre, and STIX2 by default. Custom fonts
                  require XeLaTeX.
                </p>
              </details>

              <details className="faq-item">
                <summary>How is this different from Overleaf?</summary>
                <p>
                  Overleaf sends your documents to their servers to compile. Siglum
                  compiles everything locally, so nothing leaves your machine. It's
                  usually faster since there's no network round-trip, works offline,
                  and your documents stay private.
                </p>
              </details>

              <details className="faq-item">
                <summary>Is this free?</summary>
                <p>
                  Yes, and it will stay that way. We've put a lot of thought into keeping
                  costs low. You can read about the <a href="/docs/architecture" target="_blank" rel="noopener noreferrer" className="text-link">architecture</a> if
                  you're curious, and we publish <a href="/docs/costs" target="_blank" rel="noopener noreferrer" className="text-link">what it costs each month</a> to
                  run this.
                </p>
                <p>
                  If Siglum is useful to you and you want to help keep it running,
                  you can <a href="https://github.com/sponsors/SiglumProject" target="_blank" rel="noopener noreferrer" className="text-link">sponsor the project on GitHub</a>.
                  No pressure though.
                </p>
              </details>

              <details className="faq-item">
                <summary>What engines are supported?</summary>
                <p>
                  pdfLaTeX and XeLaTeX. XeLaTeX is better for Unicode and custom fonts,
                  but pdfLaTeX works fine for most documents.
                </p>
              </details>

              <details className="faq-item">
                <summary>Why is the first compile slow?</summary>
                <p>
                  The first compilation downloads the TeX engine (~15MB) and any packages
                  you need. After that, compiles are fast since everything is cached locally.
                </p>
              </details>

              <details className="faq-item">
                <summary>Does it work offline?</summary>
                <p>
                  Yes. For the best offline experience, we recommend the <a href="/download" className="text-link">Siglum desktop app</a> for
                  Windows, Mac, and Linux. It's small (~5MB) and efficient, and if you
                  sign in with GitHub your work syncs automatically when you're back online.
                </p>
              </details>

              <details className="faq-item">
                <summary>Is this open source?</summary>
                <p>
                  Yes. The editor is MIT licensed and the underlying TeX distribution is
                  a mix of LPPL, GPL, and public domain, same as any TeX installation.
                </p>
              </details>
            </div>
          </div>
        )

      case 'support':
        return (
          <div className="doc-content">
            <h2>Support</h2>
            <p className="doc-lead">Something broken? Here's how to get help.</p>

            <div className="help-section">
              <h3>Found a bug?</h3>
              <p>
                Open an issue on GitHub with what you did, what happened, and what
                you expected. Screenshots help a lot.
              </p>
              <a
                href="https://github.com/SiglumProject/siglum-web/issues/new"
                target="_blank"
                rel="noopener noreferrer"
                className="help-link"
              >
                <Bug size={16} />
                <span>Report issue</span>
                <ArrowRight size={14} className="help-link-arrow" />
              </a>
            </div>

            <div className="help-section">
              <h3>Something not working?</h3>
              <p>
                A few things to try before opening an issue:
              </p>
              <ul className="help-list">
                <li>Hard refresh (Cmd+Shift+R or Ctrl+Shift+R)</li>
                <li>Try incognito or private browsing mode</li>
                <li>Make sure your browser is up to date</li>
              </ul>
            </div>

            <div className="help-section">
              <h3>View the source</h3>
              <p>
                Siglum is fully open source. Poke around, fork it, or submit a PR.
              </p>
              <a
                href="https://github.com/SiglumProject"
                target="_blank"
                rel="noopener noreferrer"
                className="help-link"
              >
                <Github size={16} />
                <span>GitHub</span>
                <ArrowRight size={14} className="help-link-arrow" />
              </a>
            </div>

            <div className="help-section">
              <h3>Privacy</h3>
              <p>
                Your documents stay in your browser. We can't see your source files.
              </p>
              <p>
                We use Cloudflare Analytics to see basic usage stats like page views.
                Unlike Google Analytics, Cloudflare doesn't use cookies, doesn't
                fingerprint you, and doesn't track you across the web. They just
                count visits.
              </p>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <BaseModal 
      isOpen={isOpen}
      isClosing={isClosing}
      onClose={onClose} 
      title="Help"
      maxWidth="820px"
      className="documentation-modal"
      overlayClassName="documentation-modal-overlay"
      headerContent={backButton}
    >
      <div className="doc-modal-container">
        <div className="doc-sidebar">
          <nav className="doc-nav" aria-label="Help topics">
            {tabs.map(tab => (
              <button
                key={tab.id}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={`doc-nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.id)
                  if (tab.id !== 'integrations') setSelectedIntegration(null)
                }}
              >
                <span className="doc-nav-icon">{tab.icon}</span>
                <span className="doc-nav-label">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="doc-main" key={activeTab}>
          {renderContent()}
        </div>
      </div>
    </BaseModal>
  )
}

export default DocumentationModal