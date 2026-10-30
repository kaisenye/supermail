import { BrowserWindow, Notification } from 'electron'
import { wakeDueReminders } from '../src/core/triage/reminders.js'

let timer: ReturnType<typeof setInterval> | null = null

/** Reminders fire only while the app runs (the spec's no-server rule), checked every 30s. */
export function startReminderWorker(intervalMs = 30_000): void {
  if (timer) return
  const tick = (): void => {
    try {
      const fired = wakeDueReminders()
      if (!fired.length) return
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('reminders:fired', { count: fired.length })
      if (Notification.isSupported()) {
        for (const f of fired.slice(0, 3))
          new Notification({ title: 'Reminder', body: f.subject || '(no subject)' }).show()
      }
    } catch (e) {
      console.error('[reminders] wake failed:', e)
    }
  }
  tick()
  timer = setInterval(tick, intervalMs)
}
