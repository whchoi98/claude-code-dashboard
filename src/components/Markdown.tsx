import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * In masked emails like `ab*****@domain.com`, the LLM sometimes escapes
 * every asterisk with backslashes when writing English prose (defensive
 * against being read as **bold** syntax). That looks awful when rendered:
 *   `ab\*\*\*\*\*@gmail.com`
 * We strip the escapes here so the renderer shows the intended literal
 * asterisks. The pattern is narrow — only (1–3 alphanum) followed by a
 * run of backslash-escaped asterisks immediately before an @domain — so
 * intentional `\*` in prose elsewhere is preserved.
 */
function stripMaskedEmailEscapes(text: string): string {
  return text.replace(
    /([A-Za-z0-9]{1,3})((?:\\+\*)+)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (_full, prefix: string, stars: string, domain: string) => {
      const starCount = (stars.match(/\*/g) || []).length
      return prefix + '*'.repeat(starCount) + domain
    },
  )
}

/**
 * Claude-tone markdown renderer: headings, lists, tables, inline code, links.
 * Tailwind typographic overrides applied per element; no global prose class
 * so we can tune spacing inside chat bubbles.
 */
export function Markdown({ children }: { children: string }) {
  const normalized = stripMaskedEmailEscapes(children)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: (props) => <h1 className="text-base font-semibold text-ink-800 mt-3 mb-1" {...props} />,
        h2: (props) => <h2 className="text-sm font-semibold text-ink-800 mt-3 mb-1 pb-0.5 border-b border-ink-100" {...props} />,
        h3: (props) => <h3 className="text-[13px] font-semibold text-ink-800 mt-2.5 mb-1" {...props} />,
        p:  (props) => <p className="text-sm text-ink-700 leading-relaxed my-1.5" {...props} />,
        ul: (props) => <ul className="list-disc pl-5 my-1.5 space-y-0.5 text-sm text-ink-700" {...props} />,
        ol: (props) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5 text-sm text-ink-700" {...props} />,
        li: (props) => <li className="leading-relaxed" {...props} />,
        a:  (props) => <a className="text-claude-600 underline underline-offset-2 hover:text-claude-700" target="_blank" rel="noreferrer" {...props} />,
        strong: (props) => <strong className="font-semibold text-ink-800" {...props} />,
        em: (props) => <em className="italic text-ink-700" {...props} />,
        code: ({ inline, children, ...props }: any) =>
          inline
            ? <code className="bg-paper-muted px-1 py-0.5 rounded text-[12px] font-mono text-claude-700" {...props}>{children}</code>
            : <code {...props}>{children}</code>,
        pre: (props) => (
          <pre
            className="bg-ink-800 text-paper rounded-lg px-3 py-2 my-2 overflow-x-auto text-[12px] font-mono"
            {...props}
          />
        ),
        blockquote: (props) => (
          <blockquote
            className="border-l-2 border-claude-300 pl-3 my-2 text-ink-500 italic"
            {...props}
          />
        ),
        table: (props) => (
          <div className="my-2 overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full text-[12px]" {...props} />
          </div>
        ),
        thead: (props) => <thead className="bg-paper-muted/70 text-ink-500" {...props} />,
        th: (props) => <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider text-[10px]" {...props} />,
        td: (props) => <td className="px-3 py-1 tabular-nums border-t border-ink-100" {...props} />,
        hr: () => <hr className="my-3 border-ink-100" />,
      }}
    >
      {normalized}
    </ReactMarkdown>
  )
}
