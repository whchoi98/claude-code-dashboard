import { PageHeader } from '../components/PageHeader'
import { ClaudeIcon } from '../components/ClaudeIcon'
import { ChatPanel } from '../components/chat/ChatPanel'
import { useChatStream } from '../lib/useChatStream'
import { useI18n } from '../lib/i18n'

export function Analyze() {
  const { t } = useI18n()
  const chat = useChatStream()
  const { messages } = chat

  function exportMarkdown() {
    if (messages.length === 0) return
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const lines: string[] = ['# Claude Code — Analyze', '', `> ${stamp} UTC`, '']
    for (const m of messages) {
      if (m.role === 'user') lines.push('---', '', `**Q.** ${m.text}`, '')
      else {
        if (m.toolCalls.length) lines.push(`_tools: ${m.toolCalls.map((tc) => tc.name).join(', ')}_`, '')
        if (m.text) lines.push(m.text, '')
        if (m.error) lines.push(`> ⚠ ${m.error}`, '')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `claude-code-analyze-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Browser-native print → "Save as PDF" (shared @media print mechanism).
  function exportPdf() {
    if (messages.length === 0) return
    const restore = () => document.body.classList.remove('app-print')
    document.body.classList.add('app-print')
    window.addEventListener('afterprint', restore, { once: true })
    setTimeout(() => window.print(), 50)
  }

  return (
    <div>
      <div className="print-hide">
        <PageHeader title={t('analyze.title')} subtitle={t('analyze.subtitle')} right={<ClaudeIcon size={28} animate />} />
      </div>
      <div className="p-8 max-w-5xl">
        {messages.length > 0 && (
          <div className="flex justify-end gap-2 mb-4 print-hide">
            <button onClick={exportMarkdown} title={t('analyze.export.md.hint')} className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5">
              <span aria-hidden>↓</span>{t('analyze.export.md')}
            </button>
            <button onClick={exportPdf} title={t('analyze.export.pdf.hint')} className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5">
              <span aria-hidden>🖨</span>{t('analyze.export.pdf')}
            </button>
          </div>
        )}
        <ChatPanel chat={chat} variant="page" />
      </div>
    </div>
  )
}
