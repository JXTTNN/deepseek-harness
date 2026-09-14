/**
 * Transport factory: creates the appropriate MCP server transport based on the
 * plugin's resolved config. Stdio uses standard input/output; Streamable HTTP
 * listens on the configured port.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Config } from './index.ts'

/**
 * Create an MCP server transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioServerTransport()
    case 'streamable-http':
      return createStreamableHttpTransport(config.port, config.host)
  }
}

/**
 * Create a Streamable HTTP transport backed by a Node.js HTTP server
 * listening on the configured port and host.
 *
 * The MCP SDK's StreamableHTTPServerTransport handles the MCP protocol over
 * HTTP; this factory wires it to a real listening socket so external clients
 * can connect to `http://<host>:<port>/mcp`.
 */
function createStreamableHttpTransport(port: number, host: string): Transport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only handle POST requests to the MCP endpoint; let the transport
    // own the protocol-level request/response cycle.
    if (req.method === 'POST') {
      try {
        await transport.handleRequest(req, res)
      } catch (error: unknown) {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      }
      return
    }
    // Reject non-POST methods with a clear error
    res.statusCode = 405
    res.setHeader('Allow', 'POST')
    res.end('Method Not Allowed')
  })

  // Start listening synchronously; the transport's connect() will proceed
  // once the HTTP server is ready. The unref() ensures the server does not
  // keep the process alive on its own.
  httpServer.listen(port, host)
  httpServer.unref()

  // Attach the HTTP server to the transport so disposal can close it.
  // The MCP SDK's transport.close() handles the protocol-level cleanup;
  // we patch close to also shut down the HTTP server.
  const originalClose = transport.close.bind(transport)
  transport.close = async function (): Promise<void> {
    await originalClose()
    httpServer.close()
  }

  return transport as Transport
}