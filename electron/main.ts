import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { registerIpc } from './ipc.js'
import { initDb } from '../src/core/store/db.js'
import { bootstrapAccount } from '../src/core/accounts/index.js'
import { startOutboxWorker } from '../src/core/send/flush.js'
import { getBootState, setBootState } from './state.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function boot(): void {
  initDb(join(app.getPath('userData'), 'supermail.db'))
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
      sandbox: false
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
  startOutboxWorker(() => {
    const s = getBootState()
    return s.ok ? s.config : null
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
