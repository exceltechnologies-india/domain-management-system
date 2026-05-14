'use client';

/**
 * Renders image attachments inside a support-ticket message bubble.
 * Click thumbnail to open the full image in a new tab.
 */

import { Image as ImageIcon } from 'lucide-react';

interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface Props {
  attachments?: Attachment[] | null;
  /** "user" → align right, "admin" → align left. Defaults to centered. */
  align?: 'left' | 'right' | 'center';
}

export default function MessageAttachments({ attachments, align = 'left' }: Props) {
  if (!attachments || attachments.length === 0) return null;

  const alignCls =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <div className={`flex flex-wrap gap-2 mt-2 ${alignCls}`}>
      {attachments.map((a, i) => (
        <a
          key={i}
          href={a.dataUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={a.filename}
          className="group relative block w-32 h-24 rounded-xl overflow-hidden border border-gray-200 hover:border-blue-300 bg-gray-50 shadow-sm transition-colors"
          title={`${a.filename} · ${Math.round(a.size / 1024)} KB · click to open`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={a.dataUrl} alt={a.filename} className="w-full h-full object-cover" />
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/60 to-transparent text-white text-[10px] truncate opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="inline-flex items-center gap-1">
              <ImageIcon className="h-2.5 w-2.5" />
              {a.filename}
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}
