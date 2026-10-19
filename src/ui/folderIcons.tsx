import {
  Archive,
  Clock,
  FileText,
  Folder as FolderIcon,
  Inbox,
  Mails,
  Send,
  ShieldAlert,
  Tag,
  Trash2,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { Folder } from '../core/store/types'
import type { FolderRole } from '../core/store/folderRoles'

const BY_ROLE: Record<FolderRole, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  junk: ShieldAlert,
  trash: Trash2,
  archive: Archive,
  all: Mails
}

// The user's custom Chinese folders, by leaf name.
const BY_LEAF: Record<string, LucideIcon> = {
  客户: Users, // customers
  询价: Tag, // inquiries / quotes
  跟进: Clock // follow-ups
}

export function folderIcon(f: Pick<Folder, 'path' | 'role'>): LucideIcon {
  if (f.role) return BY_ROLE[f.role]
  const leaf = f.path.split('/').pop() ?? f.path
  return BY_LEAF[leaf] ?? FolderIcon
}
