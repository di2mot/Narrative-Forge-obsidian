import { describe, it, expect } from 'vitest';
import { pingLocalLLM } from '../src/agent';
import * as http from 'http';

describe('pingLocalLLM', () => {
  it('returns an error string when the URL is empty', async () => {
    const err = await pingLocalLLM('');
    expect(typeof err).toBe('string');
    expect(err).toMatch(/not set/i);
  });

  it('returns a connection-refused message for a closed port', async () => {
    // Port 1 is reserved/closed on virtually every system.
    const err = await pingLocalLLM('http://127.0.0.1:1', 1500);
    expect(err).not.toBeNull();
    expect(err).toMatch(/ECONNREFUSED|refused|reset|connect|EADDRNOTAVAIL/i);
  });

  it('returns null when the endpoint responds 200', async () => {
    // Spin up a tiny HTTP server that answers GET /models with 200.
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('Could not start test server');
    }

    try {
      const err = await pingLocalLLM(`http://127.0.0.1:${addr.port}/v1`, 2000);
      expect(err).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns an HTTP status string when the endpoint responds non-2xx', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('Could not start test server');
    }

    try {
      const err = await pingLocalLLM(`http://127.0.0.1:${addr.port}/v1`, 2000);
      expect(err).toMatch(/HTTP 503/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
