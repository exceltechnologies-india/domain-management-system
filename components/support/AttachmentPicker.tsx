'use client';

/**
 * Reusable image attachment picker for the support system.
 * - Accepts only image/* (JPEG, PNG, WebP, GIF)
 * - Max 4 files, 2 MB each (matches server-side validateAttachments())
 * - Shows thumbnail grid with remove buttons
 * - Returns base64 data URIs so the form can POST as plain JSON
 */

import { useRef, useState } from 'react';
import { Paperclip, X, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';

export const MAX_FILES = 4;
export const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

export interface PickedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface Props {
  attachments: PickedAttachment[];
  onChange: (next: PickedAttachment[]) => void;
  disabled?: boolean;
  /** Caller-controlled label for the trigger ("Attach images", "Add screenshot"...). */
  label?: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export default function AttachmentPicker({
  attachments,
  onChange,
  disabled = false,
  label = 'Attach images',
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);

  const handleFiles = async (filesList: FileList | null) => {
    if (!filesList || filesList.length === 0) return;
    const files = Array.from(filesList);

    if (attachments.length + files.length > MAX_FILES) {
      toast.error(`You can attach at most ${MAX_FILES} images per message.`);
      return;
    }

    const accepted: PickedAttachment[] = [];
    setReading(true);
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          toast.error(`${file.name} isn't an image.`);
          continue;
        }
        if (!ACCEPT.split(',').includes(file.type)) {
          toast.error(`${file.name}: only JPEG, PNG, WebP, GIF allowed.`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is over ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
          continue;
        }
        try {
          const dataUrl = await fileToDataUrl(file);
          accepted.push({
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            dataUrl,
          });
        } catch {
          toast.error(`Failed to read ${file.name}.`);
        }
      }
    } finally {
      setReading(false);
    }
    if (accepted.length > 0) onChange([...attachments, ...accepted]);
    if (inputRef.current) inputRef.current.value = ''; // reset so same file can be re-picked
  };

  const removeAt = (idx: number) => {
    const next = attachments.slice();
    next.splice(idx, 1);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        disabled={disabled || reading || attachments.length >= MAX_FILES}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={disabled || reading || attachments.length >= MAX_FILES}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Paperclip className="h-3.5 w-3.5" />
          {reading ? 'Loading…' : label}
        </button>
        <span className="text-xs text-gray-400">
          PNG, JPG, WebP, GIF · max {Math.round(MAX_BYTES / 1024 / 1024)} MB · up to {MAX_FILES} images
        </span>
      </div>

      {attachments.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          {attachments.map((a, i) => (
            <div key={i} className="group relative border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.dataUrl}
                alt={a.filename}
                className="w-full h-24 object-cover"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeAt(i)}
                className="absolute top-1 right-1 p-1 bg-white/90 hover:bg-white text-red-500 hover:text-red-700 rounded-md shadow-sm border border-gray-200 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/60 to-transparent text-white text-[10px] truncate">
                <span className="inline-flex items-center gap-1">
                  <ImageIcon className="h-2.5 w-2.5" />
                  {a.filename}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
