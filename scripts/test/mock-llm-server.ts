/**
 * Mock LLM Server for E2E Testing
 * Simulates DeepSeek API responses for team mode testing
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = process.env.MOCK_LLM_PORT || 3000
const TIMEOUT = parseInt(process.env.MOCK_LAG || '100')

interface MockConfig {
  modelResponses: Record<string, string[]>
  toolSchema: Record<string, any>
}

const defaultConfig: MockConfig = {
  modelResponses: {
    'deepseek-v4-flash': [
      '分析结果表明，3D 模型的优化空间较大。',
      '发现了一个关键问题：材质纹理加载慢于几何体。',
      '团队协作进展顺利，我们的方案可以通过 BM25 记忆搜索快速定位。',
    ],
    'deepseek-v4-pro': [
      '经过深入推理，最佳方案是集成 Three.js 实时渲染。',
      '协调器决策：采用插件化架构，支持热插拔。',
      '子代理 solver-a 负责前端，solver-b 负责后端。',
    ],
  },
  toolSchema: {
    team_send: {
      type: 'function',
      function: {
        name: 'team_send',
        description: 'Send message to another agent or team',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient agent ID or team' },
            content: { type: 'string', description: 'Message content' },
          },
          required: ['to', 'content'],
        },
      },
    },
    team_inbox: {
      type: 'function',
      function: {
        name: 'team_inbox',
        description: 'Read unread messages from inbox',
        parameters: {
          type: 'object',
          properties: {
            maxMessages: { type: 'integer', default: 10 },
          },
        },
      },
    },
    team_list: {
      type: 'function',
      function: {
        name: 'team_list',
        description: 'List all active team members',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    team_task: {
      type: 'function',
      function: {
        name: 'team_task',
        description: 'Create or update a team task',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'complete'] },
            task: { type: 'object', description: 'Task details' },
          },
          required: ['action'],
        },
      },
    },
    team_memory: {
      type: 'function',
      function: {
        name: 'team_memory',
        description: 'Read or write team-shared memory',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'write', 'search'] },
            content: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
  },
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/'
  const startTime = Date.now()

  // Simulate network delay
  await new Promise(r => setTimeout(r, TIMEOUT))

  // Route: /v1/models
  if (url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    }))
    return
  }

  // Route: /v1/chat/completions
  if (url === '/v1/chat/completions') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
    }

    let request
    try {
      request = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const model = request.model || 'deepseek-v4-flash'
    const messages = request.messages || []
    const lastMsg = messages[messages.length - 1]?.content || ''

    // Check for tool calls
    const toolCall = request.tools?.find((t: any) => 
      t.type === 'function' && defaultConfig.toolSchema[t.function.name]
    )

    // Construct streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    // Simulate assistant thinking
    const thinkingChunks = [
      '正在分析任务...',
      '识别关键要素...', 
      '规划行动步骤...',
    ]

    for (const c of thinkingChunks) {
      const chunk = {
        id: randomUUID(),
        choices: [{ delta: { role: 'assistant', content: c }, index: 0 }],
        created: Math.floor(Date.now() / 1000),
        model,
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      await new Promise(r => setTimeout(r, TIMEOUT))
    }

    // If tool call requested, emit it
    if (toolCall) {
      const toolName = toolCall.function.name
      const args = defaultConfig.toolSchema[toolName]?.function?.properties || {}
      
      const toolChunk = {
        id: randomUUID(),
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              id: randomUUID().slice(0, 8),
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify({}) },
            }],
          },
        }],
      }
      res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
    }

    // Final content chunk
    const responses = defaultConfig.modelResponses[model] || defaultConfig.modelResponses['deepseek-v4-flash']
    const finalContent = responses[Math.floor(Math.random() * responses.length)]
    
    const finalChunk = {
      id: randomUUID(),
      choices: [{
        index: 0,
        delta: { content: finalContent },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: messages.length * 50,
        completion_tokens: finalContent.length,
        total_tokens: messages.length * 50 + finalContent.length,
      },
    }
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()

    console.log(`[MockLLM] ${request.method} ${url} - ${model} - ${Date.now() - startTime}ms`)
    return
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, () => {
  console.log(`Mock LLM Server running on port ${PORT}`)
  console.log(`Models: ${Object.keys(defaultConfig.modelResponses).join(', ')}`)
})

export { server, defaultConfig as MockLLMConfig }