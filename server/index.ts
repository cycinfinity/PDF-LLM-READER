import path from 'node:path';
import { DATA_DIR, HOST, PORT, ensureDataDir } from './config';
import { createApp } from './app';
import { DocumentStore } from './documents';
import { ChatStore, SessionStore } from './persistence';
import { SettingsStore } from './settings';

ensureDataDir();

const settingsStore = new SettingsStore();
// Text/pages and the original PDF bytes live under `<DATA_DIR>/library`, so a
// refresh (or a server restart) can restore the last opened document.
const documentStore = new DocumentStore(path.join(DATA_DIR, 'library'));
const loaded = documentStore.loadFromDisk();
const sessionStore = new SessionStore(path.join(DATA_DIR, 'session.json'));
const chatStore = new ChatStore(path.join(DATA_DIR, 'chats'));
const app = createApp({ settingsStore, documentStore, sessionStore, chatStore });

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] PDF + LLM reader API listening on http://${HOST}:${PORT}`);
  console.log(`[server] data directory: ${DATA_DIR}（文档 ${loaded} 个已恢复）`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(
      `[server] 警告：当前绑定到 ${HOST}，局域网内其他设备可以访问该服务与你的本地设置。仅应在可信网络使用。`,
    );
  }
});

function shutdown(signal: string): void {
  console.log(`[server] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
