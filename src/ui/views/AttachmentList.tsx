import { useState } from 'react'
import type { Attachment } from '../../../electron/preload'
import { AttachmentPreview, previewKind } from './AttachmentPreview'

interface Props {
  attachments: Attachment[]
}

export function AttachmentList({ attachments }: Props) {
  const [preview, setPreview] = useState<Attachment | null>(null)

  return (
    <>
      <ul className="attachments">
        {attachments.map((a) => {
          const name = a.filename ?? 'untitled'
          const canPreview = previewKind(a) !== null
          return (
            <li key={a.id} className="attachment">
              {canPreview ? (
                <button
                  type="button"
                  className="attachment-name attachment-open"
                  title={`Preview ${name}`}
                  onClick={() => setPreview(a)}
                >
                  {name}
                </button>
              ) : (
                <span className="attachment-name" title={name}>
                  {name}
                </span>
              )}
              <span className="attachment-size">{formatSize(a.size)}</span>
              <span className="attachment-actions">
                <button type="button" title="Save to disk" onClick={() => void window.api.saveAttachment(a.id)}>
                  Save
                </button>
                <button type="button" title="Open externally" onClick={() => void window.api.openAttachment(a.id)}>
                  Open
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {preview && (
        <AttachmentPreview
          attachment={preview}
          onClose={() => setPreview(null)}
          onSave={() => void window.api.saveAttachment(preview.id)}
          onOpen={() => void window.api.openAttachment(preview.id)}
        />
      )}
    </>
  )
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
