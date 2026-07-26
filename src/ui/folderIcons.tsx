import {
  Inbox,
  Send,
  FileText,
  ShieldAlert,
  Trash2,
  Folder,
  Users,
  Tag,
  Clock,
  type LucideIcon
} from 'lucide-react'

// Keyed by IMAP path first, then by leaf name for the custom Chinese folders.
const BY_PATH: Record<string, LucideIcon> = {
  INBOX: Inbox,
  'Sent Messages': Send,
  Sent: Send,
  Drafts: FileText,
  Junk: ShieldAlert,
  'Deleted Messages': Trash2,
  Trash: Trash2
}

const BY_LEAF: Record<string, LucideIcon> = {
  客户: Users, // customers
  询价: Tag, // inquiries / quotes
  跟进: Clock // follow-ups
}

export function folderIcon(path: string): LucideIcon {
  const leaf = path.split('/').pop() ?? path
  return BY_PATH[path] ?? BY_LEAF[leaf] ?? Folder
}
