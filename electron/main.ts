import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { flushPendingMoves, registerIpc } from './ipc.js'
import { initDb } from '../src/core/store/db.js'
import { initAttachmentStore } from '../src/core/store/attachments.js'
import {
  displayNameFor,
  loadStoredAccounts,
  migrateEnvAccount
} from '../src/core/accounts/manage.js'
import { initVault } from '../src/core/accounts/vault.js'
import { startOutboxWorker } from '../src/core/send/flush.js'
import { stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool } from '../src/core/sync/pool.js'
import { refreshSentFolder, startAccountWorkers } from './workers.js'
import { addAccount, getAccount, listAccounts, setBootError } from './state.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** dev: repo root (cwd). packaged: userData, since the bundle is read-only. */
function envLocalPath(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), '.env.local')
    : join(process.cwd(), '.env.local')
}

function boot(): void {
  initDb(join(app.getPath('userData'), 'supermail.db'))
  initAttachmentStore(app.getPath('userData'))
  initVault(app.getPath('userData'))

  // Lift a legacy .env.local credential into the keychain once. Runs before
  // the load below so the migrated account appears in the same pass.
  try {
    migrateEnvAccount(envLocalPath())
  } catch (e) {
    console.error('[boot] .env.local migration failed:', e)
  }

  const stored = loadStoredAccounts((id) => displayNameFor(id))
  for (const { account, config } of stored) {
    addAccount({ accountId: account.id, email: account.email, config })
  }
  // No accounts is a normal first-run state, not a crash — the renderer shows
  // onboarding rather than an error.
  if (!stored.length) setBootError('no account connected')
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
    (accountId) => getAccount(accountId)?.config ?? null,
    undefined,
    (f) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:failed', f)
    },
    (accountId) => {
      const acct = getAccount(accountId)
      if (acct) void refreshSentFolder(accountId, acct.config)
    }
  )
  // Every account gets its own warmed pool and parked IDLE connection, so mail
  // pushes for all of them rather than only whichever is on screen.
  for (const a of listAccounts()) startAccountWorkers(a.config)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // No argument: stops every account's watcher and pool.
  stopIdleWatcher()
  // SQLite already shows these moved; don't strand them mid-undo-window.
  flushPendingMoves()
  void closePool()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
