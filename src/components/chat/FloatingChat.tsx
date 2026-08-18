import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChatPanel } from './ChatPanel'
import { useChatStream } from '../../lib/useChatStream'
import { useI18n } from '../../lib/i18n'

// Keep the dragged panel this many px inside the viewport edges.
const EDGE_MARGIN = 8

export function FloatingChat() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // Drag offset (px) applied via translate on top of the bottom-right anchor.
  // Lives here (FloatingChat is mounted once in Layout) so the position the
  // user dragged to persists across open/close + route changes for the session.
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const chat = useChatStream() // one conversation, persists while mounted

  // Header-only drag: grabbing the title bar moves the whole panel. Body
  // scrolling, text selection, and the Send/Reset/Close buttons (which live
  // below, inside ChatPanel) stay clickable. Clamped to the viewport.
  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const start = { px: e.clientX, py: e.clientY, x: drag.x, y: drag.y }
    // Bounds for the offset so the panel's rect stays within the viewport.
    const minX = start.x + (EDGE_MARGIN - rect.left)
    const maxX = start.x + (window.innerWidth - rect.width - EDGE_MARGIN - rect.left)
    const minY = start.y + (EDGE_MARGIN - rect.top)
    const maxY = start.y + (window.innerHeight - rect.height - EDGE_MARGIN - rect.top)
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
    e.preventDefault()

    // Move the panel by writing transform directly (no per-frame React render);
    // commit to state once on release. `last` survives an interrupted gesture
    // (pointercancel) so cleanup always commits the real final position.
    let last = { x: start.x, y: start.y }
    const onMove = (ev: PointerEvent) => {
      last = {
        x: clamp(start.x + (ev.clientX - start.px), minX, maxX),
        y: clamp(start.y + (ev.clientY - start.py), minY, maxY),
      }
      el.style.transform = `translate(${last.x}px, ${last.y}px)`
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      setDrag(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title={t('chat.widget.open')}
          className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-[calc(1.5rem+env(safe-area-inset-right))] z-40 inline-flex items-center gap-2 rounded-full bg-claude-500 hover:bg-claude-600 text-white shadow-lg px-4 py-3 text-sm font-medium print-hide"
        >
          <span className="text-lg leading-none" aria-hidden>🤖</span>
          {t('chat.widget.open')}
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
          className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-[calc(1.5rem+env(safe-area-inset-right))] z-40 w-[400px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-3rem-env(safe-area-inset-bottom))] rounded-2xl border border-ink-100 bg-paper-muted/95 backdrop-blur shadow-2xl flex flex-col p-3 print-hide"
        >
          <div
            onPointerDown={startDrag}
            className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400 font-medium px-1 pb-1 cursor-move select-none touch-none"
          >
            <span className="text-sm" aria-hidden>🤖</span>
            {t('chat.widget.title')}
            <span className="ml-auto text-ink-300 tracking-widest" aria-hidden>⠿</span>
          </div>
          <div className="flex-1 min-h-0">
            <ChatPanel chat={chat} variant="widget" onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
