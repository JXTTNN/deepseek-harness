/**
 * Custom API Gateway Mock Server for Tes ting
 * Simulates configurable LLM endpoints  for validation
 */

import http from 'node:ht tp'

const PORT = parseInt(process.env.API_GA TEWAY_PORT || '3002')

interface EndpointConf ig {
  id: string
  baseURL: string
  apiKey? : string
  timeout?: number
}

const endpoint s: EndpointConfig[] = [
  { id: 'deepseek', b aseURL: 'https://api.deepseek.com', apiKey: ' test-deepseek-key' },
  { id: 'openai', baseU RL: 'https://api.openai.com/v1', apiKey: 'tes t-openai-key' },
  { id: 'anthropic', baseURL : 'https://api.anthropic.com', apiKey: 'test- anthropic-key' },
  { id: 'custom-gateway', b aseURL: 'https://gateway.example.com', apiKey : 'test-custom-key' },
]

const server = http .createServer(async (req, res) => {
  const u rl = req.url || '/'

  // Health check
  if ( url === '/health') {
    res.writeHead(200, {  'Content-Type': 'application/json' })
    re s.end(JSON.stringify({ status: 'ok', endpoint s: endpoints.length }))
    return
  }

  //  List configured endpoints
  if (url === '/v1/ endpoints') {
    res.writeHead(200, { 'Conte nt-Type': 'application/json' })
    res.end(J SON.stringify({ endpoints }))
    return
  }
 
  // Proxy: route /v1/{endpointId}/chat/comp letions
  const match = url.match(/^\/v1\/(\w +)\/chat\/completions$/)
  if (match) {
    c onst endpointId = match[1]
    const endpoint  = endpoints.find(e => e.id === endpointId)

     if (!endpoint) {
      res.writeHead(404,  { 'Content-Type': 'application/json' })
       res.end(JSON.stringify({ error: `Unknown en dpoint: ${endpointId}` }))
      return
    } 

    // Validate API key
    const authHeade r = req.headers['authorization']
    const ex pectedKey = `Bearer ${endpoint.apiKey}`
    i f (authHeader !== expectedKey) {
      res.wr iteHead(401, { 'Content-Type': 'application/j son' })
      res.end(JSON.stringify({ error:  'Invalid API key' }))
      return
    }

     // Read request body
    let body = ''
     for await (const chunk of req) body += chunk
     const request = JSON.parse(body)

    //  Validate request structure
    if (!request.m essages || !Array.isArray(request.messages))  {
      res.writeHead(400, { 'Content-Type':  'application/json' })
      res.end(JSON.stri ngify({ error: 'Invalid request: messages req uired' }))
      return
    }

    // Simulat e streaming response
    res.writeHead(200, { 
      'Content-Type': 'text/event-stream',
       'Cache-Control': 'no-cache',
      'Conn ection': 'keep-alive',
    })

    const resp onseContent = `Response from ${endpointId} ga teway. Model: ${request.model || 'default'}`
 
    // Thinking chunks
    for (const c of [ 'Processing...', 'Analyzing...', 'Responding. ..']) {
      res.write(`data: ${JSON.stringi fy({
        id: `mock-${Date.now()}`,
         choices: [{ delta: { content: c }, index: 0  }],
        model: request.model,
      })}\ n\n`)
      await new Promise(r => setTimeout (r, 50))
    }

    // Final chunk
    res.wr ite(`data: ${JSON.stringify({
      id: `mock -${Date.now()}`,
      choices: [{ index: 0,  delta: { content: responseContent }, finish_r eason: 'stop' }],
      usage: { prompt_token s: 100, completion_tokens: 50, total_tokens:  150 },
      model: request.model,
    })}\n\ n`)
    res.write('data: [DONE]\n\n')
    res .end()

    console.log(`[Gateway] ${endpoint Id} - ${request.model || 'default'} - OK`)
     return
  }

  // 404
  res.writeHead(404, {  'Content-Type': 'application/json' })
  res. end(JSON.stringify({ error: 'Not found', hint : 'Try /health or /v1/endpoints' }))
})

serv er.listen(PORT, () => {
  console.log(`Custom  API Gateway running on port ${PORT}`)
  cons ole.log(`Endpoints: ${endpoints.map(e => `${e .id} → ${e.baseURL}`).join(', ')}`)
})

exp ort { server, endpoints } 