'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeMarkdownUrl } from '@/lib/assistant/markdownUrl';

const prose = 'assistant-md text-sm text-gray-900 break-words [overflow-wrap:anywhere]';

export default function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className={prose}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeMarkdownUrl(url)}
        components={{
          h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold leading-snug">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-2 mb-1 text-[15px] font-semibold leading-snug">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold leading-snug">{children}</h3>,
          p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-gray-300 pl-2 text-gray-700">{children}</blockquote>
          ),
          hr: () => <hr className="my-2 border-gray-200" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => {
            const safe = href ? safeMarkdownUrl(href) : '';
            if (!safe) return <span>{children}</span>;
            const external = /^https?:/i.test(safe);
            return (
              <a
                href={safe}
                className="text-blue-700 underline break-all"
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse border border-gray-300 text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-200">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-gray-300 px-2 py-1 text-left font-semibold whitespace-nowrap">{children}</th>
          ),
          td: ({ children }) => <td className="border border-gray-300 px-2 py-1 align-top">{children}</td>,
          pre: ({ children }) => (
            <pre className="my-1.5 max-w-full overflow-x-auto rounded-md bg-gray-200 px-2 py-1.5 text-xs">{children}</pre>
          ),
          code: ({ className, children }) => {
            if (className) {
              return <code className={`${className} font-mono text-xs`}>{children}</code>;
            }
            return (
              <code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-[0.85em] break-all">{children}</code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
