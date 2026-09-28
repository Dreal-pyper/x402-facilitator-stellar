/**
 * MCP CLI integration test — the spending guard, end to end.
 *
 * Unlike {@link ../test/mcp-server.test.js | `mcp-server.test.js`}, which drives
 * `McpServer._handleRequest` in-process, this file spawns the real
 * `src/mcp/cli.js` as a child process and speaks line-delimited JSON-RPC over
 * its stdin/stdout. That is deliberate: the spending guard is the last line of
 * defence between an agent and real money, and the only way to be sure it fires
 * is to exercise the whole path the agent actually uses — process start, stdio
 * framing, `tools/call`, and the guard itself.
 *
 * The protocol-level contract (framing, batching, error tiers) is covered in
 * {@link ../test/mcp-server.test.js | `mcp-server.test.js`} and
 * {@link ../test/mcp-transport.test.js | `mcp-transport.test.js`};
 * this file is only about spending limits, so it stays deliberately small.
 *
 * @module mcp-cli-integration-test
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/server.js | MCP Server}
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | MCP CLI}
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Absolute path to the MCP CLI entry point for child-process spawning. */
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/cli.js');

/**
 * Spawns the MCP CLI and returns a minimal JSON-RPC client for it.
 *
 * The client is deliberately hand-rolled rather than reusing a transport
 * helper: it only needs one method, and keeping it inline means the test
 * documents the wire format it depends on. Frames are newline-delimited (one
 * JSON object per line), which is what `src/mcp/server.js` emits.
 *
 * The child process inherits the provided environment variables so the CLI
 * can be configured without affecting the parent process. The stderr stream
 * is piped back to the parent so diagnostic output from the CLI is visible
 * on test failure.
 *
 * Message framing uses a line-buffered approach: the child writes chunks
 * that do not align with JSON object boundaries, so a partial trailing line
 * is held in `buffer` until its newline arrives. Without this, a large
 * response would be parsed as truncated JSON and dropped.
 *
 * Pending responses are tracked by monotonic integer IDs, matching the
 * request/response IDs emitted by `src/mcp/server.js`. A child exit with
 * requests still in flight immediately rejects all pending calls rather than
 * hanging until the runner's timeout.
 *
 * @param {Record<string, string>} env - environment overrides injected into the child process
 * @returns {{callTool: (name: string, args: object) => Promise<object>, close: () => void}} An object with a `callTool` method to dispatch JSON-RPC requests and a `close` method to terminate the child process.
 * @throws {Error} If the child process exits with a non-zero code while requests are pending.
 *
 * @example
 * const client = createMcpClient({ AGENT_PAYER_SECRET_KEY: '...' });
 * const result = await client.callTool('call_paid_resource', { url: 'https://...' });
 * client.close();
 */
function createMcpClient(env) {
  const child = spawn(process.execPath, [CLI_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // The CLI logs to stderr; surface it so a failure here is diagnosable from
  // the test output rather than showing up as a bare timeout.
  child.stderr.on('data', d => process.stderr.write(d));

  // Monotonic request ids. The server echoes them, so a response can be matched
  // to its request without ordering assumptions.
  let messageId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();

  // The child writes in chunks that do not align with line boundaries, so a
  // partial trailing line is held in `buffer` until its newline arrives. Without
  // this, a large response is parsed as truncated JSON and dropped.
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            // A protocol-level failure (-32603, unknown tool, and so on).
            reject(new Error(msg.error.message));
          } else if (msg.result?.isError) {
            // A tool-level refusal — the spending guard fires this way. Both
            // tiers are rejections from the caller's point of view: this test
            // asserts on the refusal message, not on the wrapper.
            const text = msg.result.content?.[0]?.text;
            reject(new Error(typeof text === 'string' ? text : JSON.stringify(msg.result)));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        console.error('Failed to parse MCP response:', line);
      }
    }
  });

  // A child that exits with requests still in flight must not leave the test
  // hanging until the runner's timeout: fail the pending calls immediately.
  child.on('exit', code => {
    for (const { reject } of pending.values()) {
      reject(new Error(`Child exited with code ${code}`));
    }
    pending.clear();
  });

  return {
    /**
     * Dispatch a JSON-RPC `tools/call` request to the MCP CLI child process.
     *
     * @param {string} name - the tool name to call
     * @param {object} args - the tool arguments
     * @returns {Promise<object>} the resolved result from the server
     */
    callTool: (name, args) => {
      return new Promise((resolve, reject) => {
        const id = messageId++;
        pending.set(id, { resolve, reject });
        const req = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        });
        child.stdin.write(req + '\n');
      });
    },
    /** Terminate the child process. */
    close: () => {
      child.kill();
    },
  };
}

/**
 * Spending control integration test.
 *
 * Verifies that the `call_paid_resource` tool enforces per-call and session
 * spending caps. A real HTTP 402 challenge is required because the tool reads
 * the price out of the challenge body — a stub that returned a fixed price
 * would let the cap logic pass while the real parsing path was broken.
 *
 * Test setup:
 * - Per-call cap: 500 stroops
 * - Session cap: 1000 stroops
 * - Test resource: 600 stroops (exceeds the per-call cap)
 *
 * The test asserts that the 600-stroop resource is refused by the per-call cap.
 * After each test, teardown runs in reverse dependency order to ensure clean
 * shutdown: closeConnections before close so server.close() can complete its
 * handshake, and the child is killed last so it cannot outlive the fixture.
 *
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | MCP CLI spending guard}
 */
test('MCP Server Spending Controls', async t => {
  /** @type {ReturnType<typeof createMcpClient>} */
  const client = createMcpClient({
    AGENT_PAYER_SECRET_KEY: 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW', // valid testnet key
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '1000',
  });

  // A real 402 is required, not a mock return value: `call_paid_resource` reads
  // the price out of the challenge body, so the guard only has something to
  // compare against if the endpoint answers with a genuine 402. A stub that
  // returned a fixed price would let the cap logic pass while the real parsing
  // path was broken.
  //
  // The per-call cap is 500 stroops and the session cap is 1000, so a 600-stroop
  // resource must be refused by the per-call cap. That is the assertion below.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/test-200-stroops') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment_required', x402Version: 1, accepts: [{ scheme: 'exact', network: 'stellar:testnet', price: { asset: 'native', amount: '200' }, payTo: 'GBQ...' }] }));
    } else if (req.url === '/test-600-stroops') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment_required', x402Version: 1, accepts: [{ scheme: 'exact', network: 'stellar:testnet', price: { asset: 'native', amount: '600' }, payTo: 'GBQ...' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const url600 = `http://localhost:${port}/test-600-stroops`;

  /**
   * Enforces the per-call cap: a 600-stroop resource must be refused when the
   * cap is 500 stroops. This is the core assertion of the spending guard.
   *
   * The guard should reject the request and the error message must contain
   * "Spending refused" and "exceeds per-call limit".
   *
   * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | Spending guard logic}
   */
  await t.test('enforces per-call cap (600 > 500)', async () => {
    try {
      await client.callTool('call_paid_resource', { url: url600 });
      // Reaching here means the guard let an over-cap payment through — the
      // failure mode this whole file exists to prevent.
      assert.fail('Should have rejected');
    } catch (err) {
      assert.match(err.message, /Spending refused.*exceeds per-call limit/);
    }
  });

  // Teardown in reverse dependency order, and unconditionally: `closeAllConnections`
  // before `close` so `server.close()` can complete its handshake instead of
  // waiting on a keep-alive socket, and the child killed last so it cannot
  // outlive the fixture and hold the runner open.
  server.closeAllConnections();
  server.close();
  client.close();
});
