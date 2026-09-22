import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from './i18n'
import { orgParam } from './api'
import { useOrg } from './OrgProvider'

export type ToolCall = { id: string; name: string; status: 'running' | 'done' | 'error'; rowCount?: number | null }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls: ToolCall[]
  status?: string
  error?: string
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()))
const HISTORY_MAX = 12

const settleMessage = (message: ChatMessage, error?: string): ChatMessage => ({
  ...message,
  status: undefined,
  error: error ?? message.error,
  toolCalls: message.toolCalls.map((tool) => tool.status === 'running' ? { ...tool, status: 'error' } : tool),
})

export function useChatStream() {
  const { locale, t } = useI18n()
  const { org } = useOrg()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [followups, setFollowups] = useState<string[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const requestRef = useRef<{ controller: AbortController; assistantId: string } | null>(null)
  const orgRef = useRef(org)
  orgRef.current = org
  const [conversationOrg, setConversationOrg] = useState(org)
  const isCurrentOrg = conversationOrg === org
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = isCurrentOrg ? messages : []

  // Hide the previous scope even in the first org-change render. Resetting
  // only in an effect would expose the old transcript before that effect ran.
  if (!isCurrentOrg) {
    setConversationOrg(org)
    setMessages([]); setFollowups([]); setIsStreaming(false)
  }

  const cancelRequest = useCallback(() => {
    const request = requestRef.current
    requestRef.current = null
    request?.controller.abort()
    return request
  }, [])

  const reset = useCallback(() => {
    cancelRequest()
    // A caller may reset and send again before React renders the empty state.
    messagesRef.current = []
    setMessages([]); setFollowups([]); setIsStreaming(false)
  }, [cancelRequest])

  // Revoke ownership before a new scope can interact, and on unmount.
  useLayoutEffect(() => () => { cancelRequest() }, [org, cancelRequest])

  const stop = useCallback(() => {
    const request = cancelRequest()
    if (request) {
      setMessages((prev) => prev.map((message) => message.id === request.assistantId
        ? settleMessage(message, message.text.trim() ? undefined : t('chat.interrupted'))
        : message))
    }
    setIsStreaming(false)
  }, [cancelRequest, t])

  const send = useCallback(async (text: string) => {
    const q = text.trim()
    if (!q || requestRef.current || orgRef.current !== org) return
    setFollowups([])

    const history = messagesRef.current
      .filter((m) => m.text.trim())
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, text: m.text }))

    const asstId = newId()
    const controller = new AbortController()
    const request = { controller, assistantId: asstId }
    requestRef.current = request
    const isCurrent = () => requestRef.current === request && orgRef.current === org && !controller.signal.aborted
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', text: q, toolCalls: [] },
      { id: asstId, role: 'assistant', text: '', toolCalls: [] },
    ])
    setIsStreaming(true)

    const patch = (fn: (m: ChatMessage) => ChatMessage) => {
      if (isCurrent()) setMessages((prev) => prev.map((m) => (m.id === asstId ? fn(m) : m)))
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      // The org rides in the body (contract: the tool runner binds to that
      // org's keys); the query param mirrors it for the shared proxy layer.
      const res = await fetch(orgParam('/api/chat/stream', org), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q, history, locale, org }),
        signal: controller.signal,
      })
      if (!isCurrent()) {
        void res.body?.cancel().catch(() => {})
        return
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || res.statusText)
      }
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (!isCurrent()) return
        if (done) throw new Error(t('chat.interrupted'))
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split('\n\n')
        buf = chunks.pop() || ''
        for (const chunk of chunks) {
          if (!isCurrent()) return
          const lines = chunk.split('\n').filter(Boolean)
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || 'message'
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim()
          if (!dataLine) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let data: any
          try { data = JSON.parse(dataLine) } catch { continue }
          if (ev === 'status') patch((m) => ({ ...m, status: data.message }))
          if (ev === 'text') patch((m) => ({ ...m, text: m.text + data.text, status: undefined }))
          if (ev === 'tool_call') patch((m) => ({ ...m, status: undefined, toolCalls: [...m.toolCalls, { id: data.id, name: data.name, status: 'running' }] }))
          if (ev === 'tool_result') patch((m) => ({ ...m, toolCalls: m.toolCalls.map((tc) => tc.id === data.id ? { ...tc, status: data.ok ? 'done' : 'error', rowCount: data.rowCount } : tc) }))
          if (ev === 'followups') setFollowups(Array.isArray(data.suggestions) ? data.suggestions : [])
          if (ev === 'error') {
            patch((m) => settleMessage(m, data.message || t('chat.interrupted')))
            return
          }
          if (ev === 'done') {
            patch((m) => settleMessage(m, m.text.trim() ? undefined : t('chat.interrupted')))
            return
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      patch((m) => settleMessage(m, String(err?.message || e)))
    } finally {
      // Only clear if this send still owns the ref — a Stop-then-resend can
      // start a new request whose controller must not be clobbered by this
      // (now-superseded) send's late cleanup.
      if (requestRef.current === request) {
        setIsStreaming(false)
        requestRef.current = null
      }
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
  }, [locale, org, t])

  return {
    messages: isCurrentOrg ? messages : [],
    followups: isCurrentOrg ? followups : [],
    isStreaming: isCurrentOrg && isStreaming,
    send, stop, reset,
  }
}

export type ChatStream = ReturnType<typeof useChatStream>
