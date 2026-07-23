import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo, useRef, useState } from 'react'
import { CanvasBoard } from '../vdx/components/CanvasBoard'
import { ChatPanel } from '../vdx/components/ChatPanel'
import { LibraryPanel } from '../vdx/components/LibraryPanel'
import { PreviewPanel } from '../vdx/components/PreviewPanel'
import { StatusBar } from '../vdx/components/StatusBar'
import { Storyboard } from '../vdx/components/Storyboard'
import { TimelineViewer } from '../vdx/components/TimelineViewer'
import { useDirector } from '../vdx/hooks/useDirector'
import { clamp, projectDurationTicks, ticksToSeconds } from '../vdx/lib'

// Layout defaults for the resizable split (nodule drag) — mirrors the initial
// w-96 / 45% proportions the fixed layout used before it became draggable.
const DEFAULT_LEFT_WIDTH = 384
const DEFAULT_BOTTOM_FRAC = 0.45
const MIN_LEFT_WIDTH = 300
const MIN_RIGHT_WIDTH = 420
const MIN_BOTTOM_FRAC = 0.2
const MAX_BOTTOM_FRAC = 0.78

export const Route = createFileRoute('/')({ component: Home, ssr: false })

type LeftTab = 'chat' | 'library'
type RightTab = 'canvas' | 'storyboard' | 'timeline'

const TAB_BTN = (active: boolean) =>
  `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
    active
      ? 'bg-secondary text-secondary-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
  }`

function Home() {
  const director = useDirector()
  const {
    messages,
    projects,
    projectId,
    project,
    plan,
    latestRenderUrl,
    library,
    canvasItems,
    takes,
    busy,
    uploading,
    jobStatus,
    awaitingApprovalJobId,
    doneSummary,
    send,
    approvePlan,
    upload,
    retake,
    selectTake,
    moveCanvasItem,
    addCanvasNote,
    undo,
    redo,
    render,
    loadProject,
    refreshProjectList,
  } = director

  const [leftTab, setLeftTab] = useState<LeftTab>('chat')
  const [rightTab, setRightTab] = useState<RightTab>('canvas')
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [briefMode, setBriefMode] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  // Split layout: one nodule at the T-junction of the chat/library column and
  // the preview/board split drives both axes at once — drag right/left to
  // resize the left panel, drag up/down to resize preview vs. the tabbed
  // board beneath it, or drag diagonally to do both in the same gesture.
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH)
  const [bottomFrac, setBottomFrac] = useState(DEFAULT_BOTTOM_FRAC)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [nodeDragging, setNodeDragging] = useState(false)

  const dragNode = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setNodeDragging(true)
    const move = (ev: PointerEvent) => {
      const r = bodyRef.current?.getBoundingClientRect()
      if (!r) return
      setLeftWidth(clamp(ev.clientX - r.left, MIN_LEFT_WIDTH, r.width - MIN_RIGHT_WIDTH))
      setBottomFrac(clamp((r.bottom - ev.clientY) / r.height, MIN_BOTTOM_FRAC, MAX_BOTTOM_FRAC))
    }
    const up = () => {
      setNodeDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  const resetSplit = useCallback(() => {
    setLeftWidth(DEFAULT_LEFT_WIDTH)
    setBottomFrac(DEFAULT_BOTTOM_FRAC)
  }, [])

  const durationSec = useMemo(
    () => (project ? ticksToSeconds(projectDurationTicks(project)) : 0),
    [project],
  )

  const shotOrder = useMemo(() => plan?.shots.map((s) => s.id) ?? [], [plan])

  const handleSelectShot = useCallback((shotId: string) => {
    setSelectedShotId(shotId)
    setRightTab('storyboard')
  }, [])

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepthRef.current++
    setDragActive(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (hasFiles(e)) e.preventDefault()
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) upload(files, briefMode)
  }

  return (
    <div
      className="relative flex h-screen flex-col bg-background text-foreground"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="font-heading text-lg font-semibold">VDX Director</h1>
        <span className="text-xs text-muted-foreground">agent video editor</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-8 max-w-56 rounded-md border border-input bg-background px-2 text-xs"
            value={projectId ?? ''}
            disabled={busy}
            onFocus={refreshProjectList}
            onChange={(e) => loadProject(e.target.value)}
          >
            <option value="" disabled>
              {projects.length > 0 ? 'Open a project…' : 'No projects yet'}
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Body */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        {/* Left: chat / library */}
        <aside
          className="flex shrink-0 flex-col border-r border-border"
          style={{ width: leftWidth }}
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
            <button type="button" className={TAB_BTN(leftTab === 'chat')} onClick={() => setLeftTab('chat')}>
              Chat
            </button>
            <button
              type="button"
              className={TAB_BTN(leftTab === 'library')}
              onClick={() => setLeftTab('library')}
            >
              Library
              {library ? (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {library.assets.length + library.entities.length}
                </span>
              ) : null}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {leftTab === 'chat' ? (
              <ChatPanel
                messages={messages}
                plan={plan}
                busy={busy}
                uploading={uploading}
                hasProject={projectId != null}
                awaitingApproval={awaitingApprovalJobId != null}
                briefMode={briefMode}
                onBriefModeChange={setBriefMode}
                onSend={(text, gate) => send(text, { gate })}
                onApprove={approvePlan}
                onUpload={(files) => upload(files, briefMode)}
                onUndo={undo}
                onRedo={redo}
                onRender={render}
              />
            ) : (
              <LibraryPanel library={library} />
            )}
          </div>
        </aside>

        {/* Right: preview over status bar over the tabbed board */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <PreviewPanel url={latestRenderUrl} />
          </div>
          <StatusBar
            jobStatus={jobStatus}
            project={project}
            durationSec={durationSec}
            doneSummary={doneSummary}
          />
          <div
            className="flex shrink-0 flex-col"
            style={{ flexBasis: `${bottomFrac * 100}%`, flexGrow: 0, flexShrink: 0, minHeight: 220 }}
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
              <button
                type="button"
                className={TAB_BTN(rightTab === 'canvas')}
                onClick={() => setRightTab('canvas')}
              >
                Canvas
              </button>
              <button
                type="button"
                className={TAB_BTN(rightTab === 'storyboard')}
                onClick={() => setRightTab('storyboard')}
              >
                Storyboard
              </button>
              <button
                type="button"
                className={TAB_BTN(rightTab === 'timeline')}
                onClick={() => setRightTab('timeline')}
              >
                Timeline
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {rightTab === 'canvas' ? (
                <CanvasBoard
                  items={canvasItems}
                  shotOrder={shotOrder}
                  hasProject={projectId != null}
                  onMove={(itemId, pos) => moveCanvasItem(itemId, pos)}
                  onCreateNote={addCanvasNote}
                  onSelectShot={handleSelectShot}
                />
              ) : rightTab === 'storyboard' ? (
                <Storyboard
                  plan={plan}
                  takes={takes}
                  busy={busy}
                  selectedShotId={selectedShotId}
                  onRetake={retake}
                  onSelectTake={selectTake}
                />
              ) : (
                <TimelineViewer project={project} />
              )}
            </div>
          </div>
        </main>

        {/* Split-resize nodule — grab the T-junction to resize the chat panel
            (left/right) and the preview/board split (up/down) together, or
            diagonally to move both axes in one gesture. */}
        <div
          className={`vdx-resize-node${nodeDragging ? ' is-dragging' : ''}`}
          style={{ left: leftWidth, top: `${(1 - bottomFrac) * 100}%` }}
          onPointerDown={dragNode}
          onDoubleClick={resetSplit}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panels"
          title="Drag to resize · double-click to reset"
        >
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="vdx-resize-hint">
          <span className="vdx-resize-hint-dot" />
          Drag the nodule to resize · double-click to reset
        </div>
      </div>

      {/* Full-window drop overlay */}
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
          <div className="flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed border-primary/70">
            <div className="text-center">
              <p className="font-heading text-lg text-foreground">Drop files to upload</p>
              <p className="mt-1 text-xs text-muted-foreground">
                images · video · audio · md/txt/pdf/docx/rtf
                {briefMode ? ' — ingested as brief' : ''}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
