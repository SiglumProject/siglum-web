import React, { useEffect, useRef, useState, useCallback } from 'react'
import ZoteroIcon from './icons/ZoteroIcon'
import './EmptyState.css'

const welcomeTemplate = `\\documentclass[12pt]{article}
\\usepackage[margin=1.2in]{geometry}

\\title{Welcome to Siglum}
\\author{}
\\date{}

\\begin{document}
\\maketitle

Siglum is a LaTeX editor that runs entirely in your browser. Your files
never leave your machine---everything compiles locally.

\\section{Writing}

Start typing LaTeX and it compiles automatically. Try editing this
document to see the preview update on the right.

Format text with \\textbf{bold} (\\texttt{Cmd+B}) and \\textit{italic}
(\\texttt{Cmd+I}).

\\section{Features}

\\begin{itemize}
  \\item \\textbf{Auto-compile} --- preview updates as you type
  \\item \\textbf{Package fetching} --- missing packages are downloaded
    automatically from CTAN
  \\item \\textbf{Offline support} --- works without an internet connection
    after first load
  \\item \\textbf{Command palette} (\\texttt{Cmd+K}) --- search documents,
    commands, and more
  \\item \\textbf{Help} (\\texttt{Cmd+H}) --- keyboard shortcuts and
    documentation
\\end{itemize}

\\section{Next Steps}

This is a real document---edit it, delete it, or press \\texttt{Cmd+N}
to create a new one. Happy writing!

\\end{document}`

const TYPED_TEXT = ' a steep learning curve'
const INPUT_LINE = '\\input{chapters/intro}'
const PKG_LINE = '\\usepackage{tikz}'
const CITE_CMD = '\\cite{'
const CITE_SEARCH = 'gradient'
const CITE_KEY = 'ruder2016overview'
const CITE_RESULTS = [
  { key: 'ruder2016overview', title: 'An overview of gradient descent optimization algorithms', author: 'Ruder', year: '2016', type: 'article' },
  { key: 'kingma2015adam', title: 'Adam: A method for stochastic optimization', author: 'Kingma, Ba', year: '2015', type: 'inproc.' },
  { key: 'robbins1951stochastic', title: 'A stochastic approximation method', author: 'Robbins, Monro', year: '1951', type: 'article' },
]

// Render \usepackage{tikz} with progressive syntax highlighting
const renderPkgTyping = (count: number) => {
  const parts: React.ReactNode[] = []
  let rem = count
  // \usepackage = 11 display chars
  if (rem > 0) { const n = Math.min(rem, 11); parts.push(<span key="c" className="landing-cmd">{PKG_LINE.slice(0, n)}</span>); rem -= n }
  if (rem > 0) { parts.push(<span key="ob" className="landing-br">{'{'}</span>); rem-- }
  if (rem > 0) { const n = Math.min(rem, 4); parts.push(<span key="e" className="landing-env">{'tikz'.slice(0, n)}</span>); rem -= n }
  if (rem > 0) { parts.push(<span key="cb" className="landing-br">{'}'}</span>) }
  return parts
}

// Render \input{chapters/intro} with progressive syntax highlighting
const renderInputTyping = (count: number) => {
  const parts: React.ReactNode[] = []
  let rem = count
  // \input = 6 chars
  if (rem > 0) { const n = Math.min(rem, 6); parts.push(<span key="c" className="landing-cmd">{INPUT_LINE.slice(0, n)}</span>); rem -= n }
  if (rem > 0) { parts.push(<span key="ob" className="landing-br">{'{'}</span>); rem-- }
  if (rem > 0) { const n = Math.min(rem, 14); parts.push(<span key="e" className="landing-env">{'chapters/intro'.slice(0, n)}</span>); rem -= n }
  if (rem > 0) { parts.push(<span key="cb" className="landing-br">{'}'}</span>) }
  return parts
}

const renderTypedText = (count: number) => {
  if (count === 0) return null
  return <span className="landing-tx">{TYPED_TEXT.slice(0, count)}</span>
}

const DEMO_STEPS: Record<string, { label: string; desc: string }[]> = {
  compile: [
    { label: 'Type', desc: 'LaTeX source with syntax highlighting' },
    { label: 'Save', desc: 'Auto-saves as you type' },
    { label: 'Compile', desc: 'Compile the document in this browser' },
    { label: 'Cache', desc: 'Engine and package files cached locally' },
    { label: 'Recompile', desc: 'Reuse cached engine and package files' },
  ],
  writing: [
    { label: 'Before', desc: 'Markup, commands, braces \u2014 everything visible' },
    { label: 'After', desc: 'The syntax disappears. The writing stays.' },
  ],
  packages: [
    { label: 'Type', desc: 'Add \\usepackage{tikz} to the preamble' },
    { label: 'Expand', desc: 'TikZ code block appears with completions' },
    { label: 'Fetch', desc: 'tikz.sty downloaded from CTAN automatically' },
    { label: 'Resolve', desc: 'pgf dependency detected and cached' },
  ],
  zotero: [
    { label: 'Cite', desc: '\\cite{ triggers the citation popover' },
    { label: 'Search', desc: 'Results from your Zotero library' },
    { label: 'Insert', desc: 'Key inserted, BibTeX added to references.bib' },
  ],
  github: [
    { label: 'Connect', desc: 'Paste a repo URL and authenticate' },
    { label: 'Clone', desc: 'Files appear in the sidebar' },
    { label: 'Include', desc: 'Pull in chapters from the cloned repo' },
    { label: 'Push', desc: 'Edits commit and sync to GitHub' },
    { label: 'Resolve', desc: 'Merge conflict resolved inline' },
  ],
}

const NAV_SECTIONS = [
  { id: 'hero', label: 'Top' },
  { id: 'demo', label: 'Demo' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'faq', label: 'FAQ' },
]

const EmptyState: React.FC = () => {
  const revealRefs = useRef<HTMLElement[]>([])
  const navItemRefs = useRef<Map<string, HTMLAnchorElement>>(new Map())
  const [leaving, setLeaving] = useState(false)
  const [activeSection, setActiveSection] = useState('hero')
  const [navVisible, setNavVisible] = useState(false)
  const [indicatorStyle, setIndicatorStyle] = useState<{ top: number; height: number }>({ top: 0, height: 0 })

  // Demo state
  type DemoTab = 'compile' | 'writing' | 'packages' | 'zotero' | 'github'
  const [activeDemo, setActiveDemo] = useState<DemoTab>('compile')
  const [typedCount, setTypedCount] = useState(0)
  const [writingMode, setWritingMode] = useState(false)
  const [demoPhase, setDemoPhase] = useState<'idle' | 'typing' | 'writing'>('idle')
  const [fetchStage, setFetchStage] = useState(0) // 0=none, 1=tikz fetching, 2=tikz cached, 3=pgf fetching, 4=pgf cached
  const [pkgTypedCount, setPkgTypedCount] = useState(0)
  const [tikzLinesShown, setTikzLinesShown] = useState(0)
  const [showCompileBadge, setShowCompileBadge] = useState(false)
  const [compileBounce, setCompileBounce] = useState(false)
  const [showSidebarFile, setShowSidebarFile] = useState(false)
  const [showSaveToast, setShowSaveToast] = useState(false)
  const [showDependencyToast, setShowDependencyToast] = useState(false)
  // Zotero tab state
  const [citeTypedCount, setCiteTypedCount] = useState(0)
  const [showCitePopover, setShowCitePopover] = useState(false)
  const [citeSearchTyped, setCiteSearchTyped] = useState(0)
  const [citeResultsVisible, setCiteResultsVisible] = useState(0)
  const [citeSelected, setCiteSelected] = useState(-1)
  const [citeInserted, setCiteInserted] = useState(false)
  const [showBibToast, setShowBibToast] = useState(false)
  // GitHub tab state
  const [inputTypedCount, setInputTypedCount] = useState(0)
  const [showInputPreview, setShowInputPreview] = useState(false)
  const [gitPhase, setGitPhase] = useState(0)
  const [showGitModal, setShowGitModal] = useState(false)
  const [gitRepoTyped, setGitRepoTyped] = useState(0)
  const [gitCloning, setGitCloning] = useState(false)
  const [gitCloneProgress, setGitCloneProgress] = useState(0)
  const [showBranchBar, setShowBranchBar] = useState(false)
  const [showSyncPill, setShowSyncPill] = useState(false)
  const [gitHasChanges, setGitHasChanges] = useState(false)
  const [syncPillText, setSyncPillText] = useState('Synced with origin')
  const [showConflictModal, setShowConflictModal] = useState(false)
  const [conflictResolved, setConflictResolved] = useState(false)
  // Step tracking
  const [demoStep, setDemoStep] = useState(-1)
  const demoCancel = useRef<{ cancel: () => void } | null>(null)

  // Run animation when tab changes
  const playDemo = useCallback((tab: DemoTab) => {
    // Cancel any running animation
    if (demoCancel.current) demoCancel.current.cancel()

    // Reset all state
    setTypedCount(0)
    setWritingMode(false)
    setFetchStage(0)
    setPkgTypedCount(0)
    setTikzLinesShown(0)
    setShowCompileBadge(false)
    setCompileBounce(false)

    setShowSidebarFile(false)
    setShowSaveToast(false)
    setShowDependencyToast(false)
    setCiteTypedCount(0)
    setShowCitePopover(false)
    setCiteSearchTyped(0)
    setCiteResultsVisible(0)
    setCiteSelected(-1)
    setCiteInserted(false)
    setShowBibToast(false)

    setInputTypedCount(0)
    setShowInputPreview(false)
    setGitPhase(0)
    setShowGitModal(false)
    setGitRepoTyped(0)
    setGitCloning(false)
    setGitCloneProgress(0)
    setShowBranchBar(false)
    setShowSyncPill(false)
    setGitHasChanges(false)
    setSyncPillText('Synced with origin')
    setShowConflictModal(false)
    setConflictResolved(false)
    setDemoStep(-1)
    setDemoPhase('idle')
    setActiveDemo(tab)

    let active = true
    demoCancel.current = { cancel: () => { active = false } }
    const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

    const run = async () => {
      await wait(400)
      if (!active) return

      if (tab === 'compile') {
        // Step 0: Type source
        setDemoStep(0)
        setDemoPhase('typing')
        for (let i = 1; i <= TYPED_TEXT.length; i++) {
          await wait(120)
          if (!active) return
          setTypedCount(i)
        }
        // Step 1: Auto-save
        await wait(800)
        if (!active) return
        setDemoStep(1)
        setShowSaveToast(true)
        await wait(1800)
        if (!active) return
        setShowSaveToast(false)
        // Step 2: Compile locally
        await wait(600)
        if (!active) return
        setDemoStep(2)
        setShowCompileBadge(true)
        // Step 3: Dependencies cached
        await wait(1400)
        if (!active) return
        setDemoStep(3)
        setShowDependencyToast(true)
        // Step 4: Recompile with cached files
        await wait(1200)
        if (!active) return
        setShowDependencyToast(false)
        await wait(600)
        if (!active) return
        setDemoStep(4)
        setCompileBounce(true)
        await wait(600)
        if (!active) return
        setCompileBounce(false)
      } else if (tab === 'writing') {
        // Step 0: Show the markup as-is
        setDemoStep(0)
        await wait(2500)
        if (!active) return
        // Step 1: The syntax disappears
        setDemoStep(1)
        setWritingMode(true)
        setDemoPhase('writing')
      } else if (tab === 'github') {
        // Step 0: Connect repo
        setDemoStep(0)
        setGitPhase(1)
        await wait(500)
        if (!active) return
        setShowGitModal(true)
        await wait(1000)
        if (!active) return
        const repoName = 'user/thesis'
        for (let i = 1; i <= repoName.length; i++) {
          await wait(100)
          if (!active) return
          setGitRepoTyped(i)
        }
        await wait(1000)
        if (!active) return
        setGitCloning(true)
        await wait(1000)
        if (!active) return
        setShowGitModal(false)

        // Step 1: Clone files
        setDemoStep(1)
        setGitPhase(2)
        await wait(500)
        if (!active) return
        for (let i = 1; i <= 7; i++) {
          await wait(300)
          if (!active) return
          setGitCloneProgress(i)
        }
        await wait(600)
        if (!active) return

        // Step 2: Type \input{chapters/intro}
        setDemoStep(2)
        setDemoPhase('typing')
        for (let i = 1; i <= INPUT_LINE.length; i++) {
          await wait(80)
          if (!active) return
          setInputTypedCount(i)
        }
        await wait(600)
        if (!active) return
        setShowInputPreview(true)
        await wait(1000)
        if (!active) return

        // Step 3: Push
        setDemoStep(3)
        setGitPhase(3)
        setShowBranchBar(true)
        await wait(600)
        if (!active) return
        setGitHasChanges(true)
        await wait(1000)
        if (!active) return
        setGitHasChanges(false)
        setShowSyncPill(true)
        setSyncPillText('Pushed to main')
        await wait(1200)
        if (!active) return

        // Step 4: Conflict + resolve
        setDemoStep(4)
        setGitPhase(4)
        setShowSyncPill(false)
        await wait(600)
        if (!active) return
        setShowConflictModal(true)
        await wait(3000)
        if (!active) return
        setShowConflictModal(false)
        setConflictResolved(true)
        await wait(600)
        if (!active) return
        setShowSyncPill(true)
        setSyncPillText('Resolved — pushed to main')
      } else if (tab === 'packages') {
        // Step 0: Type \usepackage{tikz}
        setDemoStep(0)
        setDemoPhase('typing')
        for (let i = 1; i <= PKG_LINE.length; i++) {
          await wait(80)
          if (!active) return
          setPkgTypedCount(i)
        }
        await wait(800)
        if (!active) return

        // Step 1: Code block appears
        setDemoStep(1)
        for (let i = 1; i <= 3; i++) {
          setTikzLinesShown(i)
          await wait(400)
          if (!active) return
        }
        setDemoPhase('idle')
        await wait(500)
        if (!active) return
        setShowSidebarFile(true)

        // Step 2: Fetch tikz
        setDemoStep(2)
        setFetchStage(1)
        await wait(2400)
        if (!active) return
        setFetchStage(2)

        // Step 3: Resolve pgf
        await wait(400)
        if (!active) return
        setDemoStep(3)
        setFetchStage(3)
        await wait(1200)
        if (!active) return
        setFetchStage(4)
        await wait(2000)
        if (!active) return
        setFetchStage(5)
      } else if (tab === 'zotero') {
        // Step 0: Type \cite{
        setDemoStep(0)
        setDemoPhase('typing')
        for (let i = 1; i <= CITE_CMD.length; i++) {
          await wait(100)
          if (!active) return
          setCiteTypedCount(i)
        }
        await wait(400)
        if (!active) return

        // Step 1: Popover appears, search typed, results appear
        setDemoStep(1)
        setShowCitePopover(true)
        await wait(600)
        if (!active) return
        for (let i = 1; i <= CITE_SEARCH.length; i++) {
          await wait(100)
          if (!active) return
          setCiteSearchTyped(i)
        }
        await wait(600)
        if (!active) return
        for (let i = 1; i <= CITE_RESULTS.length; i++) {
          setCiteResultsVisible(i)
          await wait(200)
          if (!active) return
        }
        await wait(400)
        if (!active) return
        setCiteSelected(0)
        await wait(1200)
        if (!active) return

        // Step 2: Insert citation
        setDemoStep(2)
        setCiteInserted(true)
        setShowCitePopover(false)
        setDemoPhase('idle')
        await wait(600)
        if (!active) return
        setShowBibToast(true)
        setShowSidebarFile(true)
        await wait(2400)
        if (!active) return
        setShowBibToast(false)
      }
    }

    run()
  }, [])

  // Jump to a specific step — sets final state for that step instantly, then continues animation from there
  const jumpToStep = useCallback((tab: DemoTab, step: number) => {
    if (demoCancel.current) demoCancel.current.cancel()

    // Reset everything first
    setTypedCount(0)
    setWritingMode(false)
    setFetchStage(0)
    setPkgTypedCount(0)
    setTikzLinesShown(0)
    setShowCompileBadge(false)
    setCompileBounce(false)

    setShowSidebarFile(false)
    setShowSaveToast(false)
    setShowDependencyToast(false)
    setCiteTypedCount(0)
    setShowCitePopover(false)
    setCiteSearchTyped(0)
    setCiteResultsVisible(0)
    setCiteSelected(-1)
    setCiteInserted(false)
    setShowBibToast(false)

    setInputTypedCount(0)
    setShowInputPreview(false)
    setGitPhase(0)
    setShowGitModal(false)
    setGitRepoTyped(0)
    setGitCloning(false)
    setGitCloneProgress(0)
    setShowBranchBar(false)
    setShowSyncPill(false)
    setGitHasChanges(false)
    setSyncPillText('Synced with origin')
    setDemoPhase('idle')
    setActiveDemo(tab)

    // Apply cumulative state up to the target step
    if (tab === 'compile') {
      if (step >= 0) { setTypedCount(TYPED_TEXT.length); setDemoPhase('idle') }
      if (step >= 2) { setShowCompileBadge(true) }
      if (step >= 3) { setShowDependencyToast(true) }
      if (step >= 4) { setShowDependencyToast(false) }
    } else if (tab === 'writing') {
      if (step >= 1) { setWritingMode(true); setDemoPhase('writing') }
    } else if (tab === 'packages') {
      if (step >= 0) { setPkgTypedCount(PKG_LINE.length) }
      if (step >= 1) { setTikzLinesShown(3); setShowSidebarFile(true) }
      if (step >= 2) { setFetchStage(2) }
      if (step >= 3) { setFetchStage(4) }
    } else if (tab === 'zotero') {
      if (step >= 0) { setCiteTypedCount(CITE_CMD.length) }
      if (step >= 1) { setShowCitePopover(true); setCiteSearchTyped(CITE_SEARCH.length); setCiteResultsVisible(CITE_RESULTS.length); setCiteSelected(0) }
      if (step >= 2) { setShowCitePopover(false); setCiteInserted(true); setShowBibToast(true); setShowSidebarFile(true) }
    } else if (tab === 'github') {
      if (step >= 1) { setGitPhase(2); setGitCloneProgress(7) }
      if (step >= 2) { setInputTypedCount(INPUT_LINE.length); setShowInputPreview(true) }
      if (step >= 3) { setGitPhase(3); setShowBranchBar(true); setShowSyncPill(true); setSyncPillText('Pushed to main') }
      if (step >= 4) { setGitPhase(4); setConflictResolved(true); setShowSyncPill(true); setSyncPillText('Resolved \u2014 pushed to main') }
    }

    setDemoStep(step)
  }, [])

  // Play "compile" on mount after entry animation
  useEffect(() => {
    const t = setTimeout(() => playDemo('compile'), 1800)
    return () => { clearTimeout(t); if (demoCancel.current) demoCancel.current.cancel() }
  }, [])

  // Reveal animations
  useEffect(() => {
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible') }),
      { threshold: 0.12 }
    )
    revealRefs.current.forEach(el => el && obs.observe(el))
    return () => obs.disconnect()
  }, [])

  // Show nav after 40px scroll
  useEffect(() => {
    const landing = document.querySelector('.landing')
    if (!landing) return
    const onScroll = () => setNavVisible(landing.scrollTop > 40)
    landing.addEventListener('scroll', onScroll, { passive: true })
    return () => landing.removeEventListener('scroll', onScroll)
  }, [])

  // Active section tracking
  useEffect(() => {
    const els = NAV_SECTIONS.map(s => document.getElementById(s.id)).filter(Boolean) as HTMLElement[]
    if (!els.length) return

    const obs = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length) {
          visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
          setActiveSection(visible[0].target.id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px' }
    )
    els.forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const addRevealRef = (el: HTMLElement | null) => {
    if (el && !revealRefs.current.includes(el)) revealRefs.current.push(el)
  }

  // Update indicator position
  useEffect(() => {
    const el = navItemRefs.current.get(activeSection)
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    setIndicatorStyle({
      top: elRect.top - parentRect.top,
      height: elRect.height,
    })
  }, [activeSection])

  const handleOpenEditor = useCallback(async () => {
    if (leaving) return
    setLeaving(true)
    localStorage.setItem('siglum_entered_editor', '1')

    // Pre-create the file while fading out
    const welcomePath = '/project/src/welcome.tex'
    const openFile = async () => {
      const { fileManager } = await import('../services/FileManager')
      if (await fileManager.exists(welcomePath)) {
        await fileManager.openFile(welcomePath)
      } else {
        await fileManager.createFile(welcomePath, welcomeTemplate)
      }
    }

    // Wait for both the fade-out and file creation, whichever is longer
    await Promise.all([
      openFile(),
      new Promise(resolve => setTimeout(resolve, 350))
    ])
  }, [leaving])

  return (
    <div className={`landing ${leaving ? 'landing-leaving' : ''}`}>
      <div className="grain" />

      <nav className={`landing-nav ${navVisible ? 'visible' : ''}`}>
        <div className="landing-nav-track">
          <div
            className="landing-nav-indicator"
            style={{ top: indicatorStyle.top, height: indicatorStyle.height }}
          />
          {NAV_SECTIONS.map(s => (
            <a
              key={s.id}
              ref={el => { if (el) navItemRefs.current.set(s.id, el) }}
              href={`#${s.id}`}
              className={`landing-nav-item ${activeSection === s.id ? 'active' : ''}`}
              onClick={e => {
                e.preventDefault()
                document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' })
              }}
            >
              {s.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="page">
        {/* Hero */}
        <section id="hero" className="hero">
          <div className="logo">siglum<span>.</span></div>
          <h1>Open a tab,<br />start compiling <em>LaTeX</em>.</h1>
          <p className="hero-body">
            A free, open-source LaTeX editor with TeX Live in your browser.
            Documents are stored locally. Packages load on demand and are cached for offline compilation.
          </p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={handleOpenEditor}>Open the editor</button>
            <a href="https://github.com/SiglumProject" target="_blank" rel="noopener noreferrer" className="btn-ghost">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
              View source
            </a>
            <a href="/docs/" className="btn-ghost">Documentation</a>
          </div>
        </section>

        <div className="sep">&middot; &middot; &middot;</div>

        {/* Editor demo */}
        <section id="demo" className="demo">
          <div className="demo-tabs">
            <button
              className={`demo-tab ${activeDemo === 'compile' ? 'active' : ''}`}
              onClick={() => playDemo('compile')}
            >Compile Locally</button>
            <button
              className={`demo-tab ${activeDemo === 'writing' ? 'active' : ''}`}
              onClick={() => playDemo('writing')}
            >Writing Mode</button>
            <button
              className={`demo-tab ${activeDemo === 'packages' ? 'active' : ''}`}
              onClick={() => playDemo('packages')}
            >Package Fetch</button>
            <button
              className={`demo-tab ${activeDemo === 'zotero' ? 'active' : ''}`}
              onClick={() => playDemo('zotero')}
            >Zotero</button>
            <button
              className={`demo-tab ${activeDemo === 'github' ? 'active' : ''}`}
              onClick={() => playDemo('github')}
            >GitHub</button>
          </div>
          <div className={`editor-window ${writingMode ? 'demo-writing' : ''}`}>
            {/* Tab bar */}
            <div className={`demo-tabbar ${writingMode ? 'tabbar-faded' : ''}`}>
              <div className="demo-tabbar-tab active">
                <svg className="demo-tabbar-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                <span>main.tex</span>
                <span className="demo-tabbar-close">&times;</span>
              </div>
              <div className="demo-tabbar-tab">
                <svg className="demo-tabbar-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                <span>refs.bib</span>
                <span className="demo-tabbar-close">&times;</span>
              </div>
            </div>

            {/* Editor body */}
            <div className="editor-body">
              {/* Mini sidebar */}
              <div className={`demo-sidebar ${writingMode ? 'sidebar-faded' : ''}`}>
                {activeDemo === 'github' ? (
                  <div className="demo-sidebar-files">
                    {gitCloneProgress === 0 && gitPhase >= 2 && (
                      <div className="demo-git-sidebar-spinner">
                        <span className="demo-toast-spinner" />
                      </div>
                    )}
                    {gitCloneProgress >= 1 && (
                      <>
                        <div className="demo-sidebar-header">user/thesis</div>
                        <div className="demo-folder demo-file-enter">
                          <svg className="demo-folder-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" /></svg>
                          <span>src/</span>
                        </div>
                      </>
                    )}
                    {gitCloneProgress >= 2 && (
                      <div className="demo-file active nested demo-file-enter">
                        <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                        <span>main.tex</span>
                      </div>
                    )}
                    {gitCloneProgress >= 3 && (
                      <div className="demo-folder nested demo-file-enter">
                        <svg className="demo-folder-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" /></svg>
                        <span>chapters/</span>
                      </div>
                    )}
                    {gitCloneProgress >= 4 && (
                      <div className="demo-file deep-nested demo-file-enter">
                        <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                        <span>intro.tex</span>
                      </div>
                    )}
                    {gitCloneProgress >= 5 && (
                      <div className="demo-file deep-nested demo-file-enter">
                        <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                        <span>methods.tex</span>
                      </div>
                    )}
                    {gitCloneProgress >= 6 && (
                      <div className="demo-file demo-file-enter">
                        <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                        <span>refs.bib</span>
                      </div>
                    )}
                    {gitCloneProgress >= 7 && (
                      <div className="demo-folder demo-file-enter">
                        <svg className="demo-folder-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" /></svg>
                        <span>figures/</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="demo-sidebar-files">
                    <div className="demo-file active">
                      <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                      <span>main.tex</span>
                    </div>
                    <div className="demo-file">
                      <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                      <span>refs.bib</span>
                    </div>
                    <div className="demo-folder">
                      <svg className="demo-folder-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" /></svg>
                      <span>figures/</span>
                    </div>
                    <div className="demo-file nested">
                      <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                      <span>fig1.png</span>
                    </div>
                    {activeDemo === 'packages' && showSidebarFile && (
                      <div className="demo-file demo-file-enter">
                        <svg className="demo-file-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H3.5z" /></svg>
                        <span>tikz.sty</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="demo-sidebar-div" />
              <div className={`editor-src ${writingMode ? 'src-writing' : ''}`}>

                {/* Writing mode toggle — lives in breadcrumb bar */}

                {activeDemo === 'packages' ? (<>
                  {/* Packages tab: source with tikz */}
                  <div><span className="landing-ln"> 1</span><span className="landing-cmd">\documentclass</span><span className="landing-br">{'{'}</span><span className="landing-env">article</span><span className="landing-br">{'}'}</span></div>
                  {pkgTypedCount > 0 && (
                    <div className="demo-line-enter">
                      <span className="landing-ln"> 2</span>
                      {renderPkgTyping(pkgTypedCount)}
                      {pkgTypedCount < PKG_LINE.length && <span className="editor-cursor typing" />}
                    </div>
                  )}
                  <div><span className="landing-ln">{pkgTypedCount > 0 ? ' 3' : ' 2'}</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln">{pkgTypedCount > 0 ? ' 4' : ' 3'}</span><span className="landing-cmd">\section</span><span className="landing-br">{'{'}</span><span className="landing-heading">Gradient Descent</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln">{pkgTypedCount > 0 ? ' 5' : ' 4'}</span><span className="landing-tx">The update rule is best shown</span></div>
                  <div><span className="landing-ln">{pkgTypedCount > 0 ? ' 6' : ' 5'}</span><span className="landing-tx">with a diagram:</span></div>
                  {tikzLinesShown >= 1 && (
                    <div className="demo-line-enter"><span className="landing-ln">{pkgTypedCount > 0 ? ' 7' : ' 6'}</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">tikzpicture</span><span className="landing-br">{'}'}</span></div>
                  )}
                  {tikzLinesShown >= 2 && (
                    <div className="demo-line-enter demo-indented"><span className="landing-ln">{pkgTypedCount > 0 ? ' 8' : ' 7'}</span><span className="demo-indent-guide" />  <span className="landing-cmd">\draw</span><span className="landing-tx">[thick,-{'>'}</span><span className="landing-tx">] (0,0) -- (2,1);</span>{tikzLinesShown === 2 && <span className="editor-cursor typing" />}</div>
                  )}
                  {tikzLinesShown >= 3 && (
                    <div className="demo-line-enter"><span className="landing-ln">{pkgTypedCount > 0 ? ' 9' : ' 8'}</span><span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">tikzpicture</span><span className="landing-br">{'}'}</span></div>
                  )}
                  <div><span className="landing-ln">{pkgTypedCount > 0 ? (7 + tikzLinesShown).toString().padStart(2) : (6 + tikzLinesShown).toString().padStart(2)}</span><span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                </>) : activeDemo === 'writing' ? (<>
                  {/* Writing tab: source with inline formatting */}
                  <div><span className="landing-ln"> 1</span><span className="landing-cmd">\documentclass</span><span className="landing-br">{'{'}</span><span className="landing-env">article</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 2</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                  <div>
                    <span className="landing-ln"> 3</span>
                    {writingMode
                      ? <span className="landing-heading writing-heading">Gradient Descent</span>
                      : <><span className="landing-cmd">\section</span><span className="landing-br">{'{'}</span><span className="landing-heading">Gradient Descent</span><span className="landing-br">{'}'}</span></>
                    }
                  </div>
                  <div>
                    <span className="landing-ln"> 4</span>
                    <span className="landing-tx">The </span>
                    {writingMode
                      ? <span className="landing-tx writing-bold">standard approach</span>
                      : <><span className="landing-cmd">\textbf</span><span className="landing-br">{'{'}</span><span className="landing-tx">standard approach</span><span className="landing-br">{'}'}</span></>
                    }
                    <span className="landing-tx"> to</span>
                  </div>
                  <div><span className="landing-ln"> 5</span><span className="landing-tx">optimisation adjusts weights in</span></div>
                  <div><span className="landing-ln"> 6</span><span className="landing-tx">the direction that reduces loss.</span></div>
                  <div>
                    <span className="landing-ln"> 7</span>
                    <span className="landing-tx">This is called </span>
                    {writingMode
                      ? <span className="landing-tx writing-italic">gradient descent</span>
                      : <><span className="landing-cmd">\textit</span><span className="landing-br">{'{'}</span><span className="landing-tx">gradient descent</span><span className="landing-br">{'}'}</span></>
                    }
                    <span className="landing-tx">.</span>
                  </div>
                  <div><span className="landing-ln"> 8</span></div>
                  <div>
                    <span className="landing-ln"> 9</span>
                    {writingMode
                      ? <span className="landing-heading writing-subheading">Convergence</span>
                      : <><span className="landing-cmd">\subsection</span><span className="landing-br">{'{'}</span><span className="landing-heading">Convergence</span><span className="landing-br">{'}'}</span></>
                    }
                  </div>
                  <div className={`${writingMode ? 'demo-active-line' : ''}`}>
                    <span className="landing-ln">10</span>
                    <span className="landing-tx">Under </span>
                    {writingMode
                      ? <span className="landing-tx writing-bold">mild assumptions</span>
                      : <><span className="landing-cmd">\textbf</span><span className="landing-br">{'{'}</span><span className="landing-tx">mild assumptions</span><span className="landing-br">{'}'}</span></>
                    }
                    <span className="landing-tx"> on</span>
                    {demoPhase === 'writing' && <span className="editor-cursor writing" />}
                  </div>
                  <div><span className="landing-ln">11</span><span className="landing-tx">the loss surface, the weights</span></div>
                  <div><span className="landing-ln">12</span><span className="landing-tx">converge to a local minimum.</span></div>
                  <div><span className="landing-ln">13</span><span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                </>) : activeDemo === 'zotero' ? (<>
                  {/* Zotero tab: source with \cite */}
                  <div><span className="landing-ln"> 1</span><span className="landing-cmd">\documentclass</span><span className="landing-br">{'{'}</span><span className="landing-env">article</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 2</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 3</span><span className="landing-cmd">\section</span><span className="landing-br">{'{'}</span><span className="landing-heading">Gradient Descent</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 4</span><span className="landing-tx">The standard parameter update</span></div>
                  <div className={citeTypedCount > 0 && !citeInserted ? 'demo-cursor-line' : ''}>
                    <span className="landing-ln"> 5</span>
                    <span className="landing-tx">rule follows </span>
                    {citeInserted ? (
                      <><span className="landing-cmd">\cite</span><span className="landing-br">{'{'}</span><span className="landing-env">{CITE_KEY}</span><span className="landing-br">{'}'}</span></>
                    ) : citeTypedCount > 0 ? (
                      <><span className="landing-cmd">{CITE_CMD.slice(0, citeTypedCount)}</span>{citeTypedCount < CITE_CMD.length && <span className="editor-cursor typing" />}</>
                    ) : null}
                    <span className="landing-tx">.</span>
                  </div>
                  <div><span className="landing-ln"> 6</span><span className="landing-tx">At each step, the weights are</span></div>
                  <div><span className="landing-ln"> 7</span><span className="landing-tx">adjusted in the direction that</span></div>
                  <div><span className="landing-ln"> 8</span><span className="landing-tx">minimises the loss. This converges</span></div>
                  <div><span className="landing-ln"> 9</span><span className="landing-tx">under mild assumptions on the</span></div>
                  <div><span className="landing-ln">10</span><span className="landing-tx">loss surface.</span></div>
                  <div><span className="landing-ln">11</span><span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                </>) : activeDemo === 'github' ? (<>
                  {/* GitHub tab: source with \input + conflict */}
                  <div><span className="landing-ln"> 1</span><span className="landing-cmd">\documentclass</span><span className="landing-br">{'{'}</span><span className="landing-env">article</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 2</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 3</span><span className="landing-cmd">\section</span><span className="landing-br">{'{'}</span><span className="landing-heading">Gradient Descent</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 4</span><span className="landing-tx">The standard parameter update</span></div>
                  <div><span className="landing-ln"> 5</span><span className="landing-tx">rule follows a steep learning</span></div>
                  <div><span className="landing-ln"> 6</span><span className="landing-tx">curve.</span></div>
                  {inputTypedCount > 0 && (
                    <div className={`demo-line-enter ${!conflictResolved ? 'demo-cursor-line' : ''}`}>
                      <span className="landing-ln"> 7</span>
                      {renderInputTyping(inputTypedCount)}
                      {inputTypedCount < INPUT_LINE.length && <span className="editor-cursor typing" />}
                    </div>
                  )}
                  {conflictResolved && (
                    <div className="demo-line-enter">
                      <span className="landing-ln">{inputTypedCount > 0 ? ' 8' : ' 7'}</span>
                      <span className="landing-cmd">\input</span><span className="landing-br">{'{'}</span><span className="landing-env">chapters/methods</span><span className="landing-br">{'}'}</span>
                    </div>
                  )}
                  <div><span className="landing-ln">{conflictResolved ? ' 9' : inputTypedCount > 0 ? ' 8' : ' 7'}</span><span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                </>) : (<>
                  {/* Default source — Gradient Descent */}
                  <div><span className="landing-ln"> 1</span><span className="landing-cmd">\documentclass</span><span className="landing-br">{'{'}</span><span className="landing-env">article</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 2</span><span className="landing-cmd">\begin</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 3</span><span className="landing-cmd">\section</span><span className="landing-br">{'{'}</span><span className="landing-heading">Gradient Descent</span><span className="landing-br">{'}'}</span></div>
                  <div><span className="landing-ln"> 4</span><span className="landing-tx">The standard parameter update</span></div>
                  <div className={`${demoPhase === 'typing' || demoPhase === 'writing' ? 'demo-cursor-line' : ''} ${writingMode ? 'demo-active-line' : ''}`}>
                    <span className="landing-ln"> 5</span>
                    <span className="landing-tx">rule follows</span>
                    {renderTypedText(typedCount)}
                    {demoPhase === 'typing' && <span className="editor-cursor typing" />}
                    {demoPhase === 'writing' && <span className="editor-cursor writing" />}
                    <span className="landing-tx">.</span>
                  </div>
                  <div><span className="landing-ln"> 6</span><span className="landing-tx">At each step, the weights are</span></div>
                  <div><span className="landing-ln"> 7</span><span className="landing-tx">adjusted in the direction that</span></div>
                  <div><span className="landing-ln"> 8</span><span className="landing-tx">minimises the loss. This converges</span></div>
                  <div><span className="landing-ln"> 9</span><span className="landing-tx">under mild assumptions on the</span></div>
                  <div><span className="landing-ln">10</span><span className="landing-tx">loss surface.</span></div>
                  <div className={demoPhase === 'idle' ? 'demo-cursor-line' : ''}>
                    <span className="landing-ln">11</span>
                    <span className="landing-cmd">\end</span><span className="landing-br">{'{'}</span><span className="landing-env">document</span><span className="landing-br">{'}'}</span>
                    {demoPhase === 'idle' && <span className="editor-cursor" />}
                  </div>
                </>)}
              </div>
              <div className="editor-div" />
              <div className="editor-preview">
                {/* Preview toolbar */}
                <div className={`demo-preview-toolbar ${writingMode ? 'toolbar-faded' : ''}`}>
                  <span className="demo-preview-toolbar-label">Preview</span>
                  <div className="demo-preview-toolbar-spacer" />
                  <span className="demo-preview-toolbar-btn">&minus;</span>
                  <span className="demo-preview-toolbar-zoom">100%</span>
                  <span className="demo-preview-toolbar-btn">+</span>
                  <span className="demo-preview-toolbar-sep" />
                  <svg className="demo-preview-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
                </div>
                <div className={`preview-viewer ${writingMode ? 'preview-hidden' : ''}`}>
                  <div className="preview-page">
                    {activeDemo === 'packages' ? (<>
                      <h3>1&ensp;Gradient Descent</h3>
                      <p>The standard parameter update rule follows:</p>
                      {fetchStage >= 2 && (
                        <div className="demo-tikz-preview">
                          <svg viewBox="0 0 140 70" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <defs><marker id="ah" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="currentColor" strokeWidth="1.2" /></marker></defs>
                            <line x1="15" y1="55" x2="115" y2="15" markerEnd="url(#ah)" />
                          </svg>
                        </div>
                      )}
                    </>) : activeDemo === 'github' ? (<>
                      <h3>1&ensp;Gradient Descent</h3>
                      <p>The standard parameter update rule follows a steep learning curve.</p>
                      {showInputPreview && (
                        <div className="demo-input-preview">
                          <p>Gradient descent dates back to Cauchy (1847). The method was later formalised for stochastic settings by Robbins and Monro.</p>
                        </div>
                      )}
                      {conflictResolved && (
                        <div className="demo-input-preview">
                          <p>We extend this with momentum and adaptive rates. Nesterov acceleration further improves convergence on convex surfaces.</p>
                        </div>
                      )}
                    </>) : (<>
                      <h3>1&ensp;Gradient Descent</h3>
                      <p>The standard parameter update rule follows{typedCount >= TYPED_TEXT.length ? ' a steep learning curve' : ''}. At each step, the weights are adjusted in the direction that minimises the loss. This converges under mild assumptions on the loss surface.</p>
                    </>)}
                    <span className="preview-page-number">1</span>
                  </div>
                  <div className="preview-nav">
                    <span className="preview-nav-pages">1 / 1</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Save toast */}
            {showSaveToast && (
              <div className="demo-pill demo-pill--muted demo-save-toast">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                Saved
              </div>
            )}

            {/* Cached dependencies toast */}
            {showDependencyToast && (
              <div className="demo-pill demo-pill--accent demo-preamble-toast">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                Dependencies cached
              </div>
            )}


            {/* Compile badge */}
            {showCompileBadge && (
              <div className={`demo-pill demo-pill--accent demo-compile-badge ${compileBounce ? 'demo-bounce' : ''}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                Compiled locally
              </div>
            )}

            {/* Bib toast */}
            {showBibToast && (
              <div className="demo-pill demo-pill--accent demo-bib-toast">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                Added to references.bib
              </div>
            )}

            {/* Package fetch toasts */}
            {fetchStage > 0 && fetchStage < 5 && (
              <div className="demo-toasts">
                <div className={`demo-toast ${fetchStage >= 2 ? 'cached' : ''}`} key="tikz">
                  <span className="demo-toast-icon">{fetchStage >= 2 ? '\u2713' : ''}</span>
                  <span className="demo-toast-pkg">tikz</span>
                  <span className="demo-toast-status">{fetchStage >= 2 ? 'cached' : 'fetching from CTAN\u2026'}</span>
                  {fetchStage < 2 && <span className="demo-toast-spinner" />}
                </div>
                {fetchStage >= 3 && (
                  <div className={`demo-toast ${fetchStage >= 4 ? 'cached' : ''}`} key="pgf">
                    <span className="demo-toast-icon">{fetchStage >= 4 ? '\u2713' : ''}</span>
                    <span className="demo-toast-pkg">pgf</span>
                    <span className="demo-toast-status">{fetchStage >= 4 ? 'cached' : 'resolving dependency\u2026'}</span>
                    {fetchStage < 4 && <span className="demo-toast-spinner" />}
                  </div>
                )}
              </div>
            )}

            {/* Git branch bar */}
            {activeDemo === 'github' && showBranchBar && (
              <div className="demo-branch-bar">
                <svg className="demo-branch-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span className="demo-branch-name">main</span>
                {gitHasChanges && <span className="demo-branch-dot" />}
              </div>
            )}

            {/* Git sync pill */}
            {activeDemo === 'github' && showSyncPill && (
              <div className={`demo-pill demo-pill--accent demo-sync-pill ${syncPillText === 'Pushed to main' ? 'demo-pulse' : ''}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                {syncPillText}
              </div>
            )}

            {/* Git conflict modal */}
            {showConflictModal && (
              <div className="demo-conflict-overlay">
                <div className="demo-conflict-modal">
                  <h3 className="demo-conflict-title">Conflicting Changes</h3>
                  <span className="demo-conflict-repo">user/thesis</span>
                  <ul className="demo-conflict-files">
                    <li>
                      <span className="demo-conflict-file-name">main.tex</span>
                      <span className="demo-conflict-file-lines">3 lines different</span>
                    </li>
                  </ul>
                  <p className="demo-conflict-desc">This version and the GitHub version are different.</p>
                  <div className="demo-conflict-actions">
                    <button className="demo-conflict-btn secondary">Keep This Version</button>
                    <button className="demo-conflict-btn primary">Use Latest from GitHub</button>
                  </div>
                </div>
              </div>
            )}

            {/* Git connect modal */}
            {showGitModal && (
              <div className="demo-git-overlay">
                <div className="demo-git-modal">
                  <div className="demo-git-modal-header">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                    <span className="demo-git-modal-title">Connect repository</span>
                  </div>
                  <div className="demo-git-input-wrap">
                    <input
                      className="demo-git-input"
                      type="text"
                      readOnly
                      value={'user/thesis'.slice(0, gitRepoTyped)}
                      placeholder="owner/repo"
                    />
                    {gitRepoTyped < 11 && gitRepoTyped > 0 && <span className="editor-cursor typing demo-input-cursor" />}
                  </div>
                  <button className={`demo-btn primary demo-git-btn ${gitCloning ? 'cloning' : ''}`}>
                    {gitCloning ? (
                      <><span className="demo-toast-spinner" /> Cloning...</>
                    ) : (
                      'Connect'
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Citation popover — outside editor-src so it isn't clipped */}
            {showCitePopover && (
              <div className="demo-cite-popover">
                <div className="demo-cite-search">
                  <svg className="demo-cite-search-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                  <span className="demo-cite-search-text">{CITE_SEARCH.slice(0, citeSearchTyped)}{citeSearchTyped < CITE_SEARCH.length && <span className="editor-cursor typing" />}</span>
                </div>
                <div className="demo-cite-results">
                  {CITE_RESULTS.slice(0, citeResultsVisible).map((r, i) => (
                    <div key={r.key} className={`demo-cite-result ${i === citeSelected ? 'selected' : ''}`}>
                      <span className="demo-cite-type">{r.type}</span>
                      <span className="demo-cite-key">{r.key}</span>
                      <span className="demo-cite-title">{r.title}</span>
                      <span className="demo-cite-meta">{r.author} {r.year}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Demo script steps */}
          <div className="demo-script">
            {DEMO_STEPS[activeDemo].map((step, i) => (
              <button
                key={`${activeDemo}-${i}`}
                className={`demo-script-step ${i === demoStep ? 'active' : ''} ${i < demoStep ? 'past' : ''}`}
                onClick={() => jumpToStep(activeDemo, i)}
              >
                <span className="demo-script-num">{i + 1}</span>
                <span className="demo-script-label">{step.label}</span>
                <span className="demo-script-desc">{step.desc}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Integrations */}
        <section id="integrations" className="integrations reveal" ref={addRevealRef}>
          <p className="section-label">Integrations</p>
          <p className="section-intro">Everything runs locally by default. These are optional &mdash; connect them when you need version control or citation management.</p>
          <div className="int-list">
            <div className="int-row">
              <svg className="int-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
              <span className="int-row-name">GitHub</span>
              <span className="int-row-desc">Version control, backup, and collaboration for every project.</span>
              <span className="int-row-pill">Available</span>
            </div>
            <div className="int-row">
              <ZoteroIcon size={18} className="int-icon" />
              <span className="int-row-name">Zotero</span>
              <span className="int-row-desc">Import citations from your library. BibTeX entries sync to <code>references.bib</code>.</span>
              <span className="int-row-pill">Available</span>
            </div>
            <div className="int-row int-row-soon">
              <svg className="int-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5zM8 13h8v1.5H8V13zm0 3h6v1.5H8V16z" /></svg>
              <span className="int-row-name">Mendeley</span>
              <span className="int-row-desc">Import your reference library directly.</span>
              <span className="int-row-pill int-row-pill-soon">Coming soon</span>
            </div>
          </div>
          <p className="int-footer">
            Something missing? <a href="https://github.com/SiglumProject/siglum/issues/new?title=Integration%20request%3A%20" target="_blank" rel="noopener noreferrer">Suggest an integration</a>
          </p>
        </section>

        {/* FAQ */}
        <section id="faq" className="faq reveal" ref={addRevealRef}>
          <p className="section-label">Q &A </p>

          <div className="faq-list">
            <details className="faq-item">
              <summary>Do you store my documents?</summary>
              <p>Your documents are stored in this browser and compilation runs locally. Optional GitHub sync sends the selected repository files to GitHub through a relay. <a href="/docs/storage/">Read about storage and optional connections.</a></p>
            </details>
            <details className="faq-item">
              <summary>Is my work saved?</summary>
              <p>Edits save automatically in this browser. Clearing site data removes local storage. Export your files or use optional GitHub sync for a separate copy. <a href="/docs/storage/">Storage and offline use.</a></p>
            </details>
            <details className="faq-item">
              <summary>How is this different from Overleaf?</summary>
              <p>Siglum runs TeX in your browser and stores documents locally. Editing and compilation require no account. Cached dependencies support offline compilation, and the compiler is also available as an <a href="/docs/engine/">open-source npm package</a>.</p>
            </details>
            <details className="faq-item">
              <summary>Can I use custom fonts?</summary>
              <p>Yes. Drop a <code>.ttf</code> or <code>.otf</code> in your project and use fontspec. Latin Modern, TeX Gyre, and STIX2 are included. Custom fonts need XeLaTeX.</p>
            </details>
            <details className="faq-item">
              <summary>Can I use [obscure package]?</summary>
              <p>Probably. Common packages are bundled, and anything else gets fetched from CTAN automatically the first time you use it.</p>
            </details>
            <details className="faq-item">
              <summary>Why does the first compile take longer?</summary>
              <p>It downloads the engine and any packages you need. After that, everything's cached and compiles are fast.</p>
            </details>
            <details className="faq-item">
              <summary>Is this free?</summary>
              <p>Yes. Siglum is free and open-source.</p>
            </details>
          </div>
        </section>


      </div>
    </div>
  )
}

export default EmptyState
