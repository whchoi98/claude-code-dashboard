import { useState } from 'react'
import { ClaudeIcon } from '../ClaudeIcon'
import { useI18n } from '../../lib/i18n'

export function ChatComposer({
  isStreaming, onSend, onStop,
}: { isStreaming: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  const submit = () => {
    const q = value.trim()
    if (!q || isStreaming) return
    onSend(q); setValue('')
  }

  return (
    <div className="rounded-xl border border-ink-100 bg-white shadow-card p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        rows={2}
        placeholder={t('chat.placeholder')}
        className="w-full text-sm bg-paper-muted/30 border border-ink-100 rounded-lg px-3 py-2 focus:outline-none focus:border-claude-500 resize-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        {isStreaming && (
          <button onClick={onStop} className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 text-ink-500 hover:bg-paper-muted">
            {t('chat.stop')}
          </button>
        )}
        <button
          onClick={submit}
          disabled={isStreaming || !value.trim()}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-claude-500 hover:bg-claude-600 disabled:opacity-50 text-white text-sm font-medium"
        >
          <ClaudeIcon size={14} tone="ghost" className="opacity-90" />
          {isStreaming ? t('chat.thinking') : t('chat.send')}
        </button>
      </div>
    </div>
  )
}
