import { useState } from 'react'
import { ClaudeIcon } from '../ClaudeIcon'
import { ChatPanel } from './ChatPanel'
import { useChatStream } from '../../lib/useChatStream'
import { useI18n } from '../../lib/i18n'

export function FloatingChat() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const chat = useChatStream() // one conversation, persists while mounted

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title={t('chat.widget.open')}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-claude-500 hover:bg-claude-600 text-white shadow-lg px-4 py-3 text-sm font-medium print-hide"
        >
          <ClaudeIcon size={18} tone="ghost" />
          {t('chat.widget.open')}
        </button>
      )}
      {open && (
        <div className="fixed bottom-6 right-6 z-40 w-[400px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-3rem)] rounded-2xl border border-ink-100 bg-paper-muted/95 backdrop-blur shadow-2xl flex flex-col p-3 print-hide">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium px-1 pb-1">{t('chat.widget.title')}</div>
          <div className="flex-1 min-h-0">
            <ChatPanel chat={chat} variant="widget" onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
