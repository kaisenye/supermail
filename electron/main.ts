import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { flushPendingMoves, registerIpc } from './ipc.js'
import { initDb } from '../src/core/store/db.js'
import { initAttachmentStore } from '../src/core/store/attachments.js'
import { bootstrapAccount } from '../src/core/accounts/index.js'
import { startOutboxWorker } from '../src/core/send/flush.js'
import { startIdleWatcher, stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool, getPool } from '../src/core/sync/pool.js'
import { getBootState, setBootState } from './state.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function boot(): void {
  initDb(join(app.getPath('userData'), 'supermail.db'))
  initAttachmentStore(app.getPath('userData'))
  try {
    // dev: repo root (cwd). packaged: userData, since the bundle is read-only.
    const envPath = app.isPackaged
      ? join(app.getPath('userData'), '.env.local')
      : join(process.cwd(), '.env.local')
    const { account, config } = bootstrapAccount(envPath)
    setBootState({ ok: true, accountId: account.id, email: account.email, config })
  } catch (e) {
    // No creds yet is a normal first-run state, not a crash.
    setBootState({ ok: false, error: (e as Error).message })
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Matches --bg so launch never flashes white before first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d10' : '#fcfcfb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      // Throttling stalls rAF while occluded, which stalls canvas rendering.
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  boot()
  registerIpc()
  startOutboxWorker(
    () => {
      const s = getBootState()
      return s.ok ? s.config : null
    },
    undefined,
    (f) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:failed', f)
    }
  )
  // Tell the renderer to run its normal sync, so IDLE reuses the 'sync:run' guard.
  const s = getBootState()
  if (s.ok) {
    // Pay the ~2.7s handshake now, while nothing is waiting on it.
    void getPool(s.config).warm()
    startIdleWatcher(s.config, () => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:new')
    })
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopIdleWatcher()
  // SQLite already shows these moved; don't strand them mid-undo-window.
  flushPendingMoves()
  void closePool()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
