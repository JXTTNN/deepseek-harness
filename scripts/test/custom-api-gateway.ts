/**
 * Custom API Gateway Mock Server for Testing
 * Simulates configurable LLM endpoints for validation
 */

import http from 'node:http'

const PORT = parseInt(process.env.API_GATEWAY_PORT || '3002')

interface EndpointConfig {
  id: string
  baseURL: string
  apiKey?: string
  timeout?: number
}

const endpoints: EndpointConfig[] = [
  { id: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'test-deepseek-key' },
  { id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'test-openai-key' },
  { id: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'test-anthropic-key' },
  { id: 'custom-gateway', baseURL: 'https://gateway.example.com', apiKey: 'test-custom-key' },
]

const server = http.createServer(async (req, res) => {
  const url = req.url || '/'

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', endpoints: endpoints.length }))
    return
  }

  // List configured endpoints
  if (url === '/v1/endpoints') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ endpoints }))
    return
  }

  // Proxy: route /v1/{endpointId}/chat/completions
  const match = url.match(/^\/v1\/(\w+)\/chat\/completions$/)
  if (match) {
    const endpointId = match[1]
    const endpoint = endpoints.find(e => e.id === endpointId)

    if (!endpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Unknown endpoint: ${endpointId}` }))
      return
    }

    // Validate API key
    const authHeader = req.headers['authorization']
    const expectedKey = `Bearer ${endpoint.apiKey}`
    if (authHeader !== expectedKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid API key' }))
      return
    }

    // Read request body
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)

    // Validate request structure
    if (!request.messages || !Array.isArray(request.messages)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid request: messages required' }))
      return
    }

    // Simulate streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const responseContent = `Response from ${endpointId} gateway. Model: ${request.model || 'default'}`

    // Thinking chunks
    for (const c of ['Processing...', 'Analyzing...', 'Responding...']) {
      res.write(`data: ${JSON.stringify({
        id: `mock-${Date.now()}`,
        choices: [{ delta: { content: c }, index: 0 }],
        model: request.model,
      })}\n\n`)
      await new Promise(r => setTimeout(r, 50))
    }

    // Final chunk
    res.write(`data: ${JSON.stringify({
      id: `mock-${Date.now()}`,
      choices: [{ index: 0, delta: { content: responseContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      model: request.model,
    })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()

    console.log(`[Gateway] ${endpointId} - ${request.model || 'default'} - OK`)
    return
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found', hint: 'Try /health or /v1/endpoints' }))
})

server.listen(PORT, () => {
  console.log(`Custom API Gateway running on port ${PORT}`)
  console.log(`Endpoints: ${endpoints.map(e => `${e.id} → ${e.baseURL}`).join(', ')}`)
})

export { server, endpoints }