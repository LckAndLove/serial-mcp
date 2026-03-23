import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const clientEntry = require.resolve('@modelcontextprotocol/client', {
  paths: [path.join(root, 'serial-mcp')],
});
const stdioEntry = require.resolve('@modelcontextprotocol/client/stdio', {
  paths: [path.join(root, 'serial-mcp')],
});

function waitForLine(child, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待 MCP 响应超时'));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (predicate(message)) {
            cleanup();
            resolve(message);
            return;
          }
        } catch {
          // Ignore non-JSON diagnostics; MCP stdio must still answer JSON-RPC.
        }
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
    };

    child.stdout.on('data', onData);
    child.on('error', onError);
  });
}

test('MCP server exposes the tool list over legacy stdio handshake', async () => {
  const child = spawn(process.execPath, [path.join(root, 'serial-mcp', 'server.js')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'serial-mcp-test', version: '1.0.0' },
      },
    })}\n`);

    const initialized = await waitForLine(child, (message) => message.id === 1);
    assert.equal(initialized.error, undefined);
    assert.ok(initialized.result?.protocolVersion);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })}\n`);

    const tools = await waitForLine(child, (message) => message.id === 2);
    assert.equal(tools.error, undefined);
    assert.equal(tools.result.tools.length, 12);
    assert.ok(tools.result.tools.some((tool) => tool.name === 'open_monitor'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
  }
});

test('v2 client auto-negotiates the modern stdio protocol', async () => {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientEntry).href),
    import(pathToFileURL(stdioEntry).href),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'serial-mcp', 'server.js')],
    cwd: root,
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'serial-mcp-v2-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 12);
    assert.equal(client.getProtocolEra(), 'modern');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('security-sensitive inputs are guarded in source', async () => {
  const server = await readFile(path.join(root, 'serial-mcp', 'server.js'), 'utf8');
  const listener = await readFile(path.join(root, 'serial-mcp', 'lib', 'listener.js'), 'utf8');
  const virtualDevice = await readFile(path.join(root, 'serial-virtual', 'virtual-device.js'), 'utf8');

  assert.match(server, /serveStdio/);
  assert.match(server, /maxBufferSize: MAX_STDIO_BUFFER_SIZE/);
  assert.match(server, /spawn\(monitorCmd, monitorArgs/);
  assert.doesNotMatch(server, /batContent|explorer\.exe/);
  assert.match(listener, /authorization/);
  assert.match(listener, /MAX_FRAME_SIZE/);
  assert.doesNotMatch(listener, /Access-Control-Allow-Origin/);
  assert.match(virtualDevice, /MAX_INPUT_BUFFER/);
});

test('invalid monitor arguments are rejected before process launch', async () => {
  const source = await readFile(path.join(root, 'serial-mcp', 'server.js'), 'utf8');
  assert.match(source, /port 格式无效/);
  assert.match(source, /MAX_RESPONSE_TIMEOUT/);
});
