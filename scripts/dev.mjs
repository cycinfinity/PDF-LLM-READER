// Dev runner: starts the API and the Vite dev server without shell expansion.
// Using child_process.spawn directly keeps this working when the project path
// contains spaces (e.g. "KEY POINTS"), which an npm/`sh -c` wrapper can mangle.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = [];
let shuttingDown = false;

function binPath(name) {
  return fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', (error) => {
    console.error(`[${name}] 启动失败: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] 已退出 (${signal ?? code})`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', binPath('tsx'), ['watch', 'server/index.ts']);
start('web', binPath('vite'), ['--port', '5173', '--strictPort']);

console.log('[dev] API http://127.0.0.1:8787  |  Web http://localhost:5173');
