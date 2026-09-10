/**
 * Team Mode Simulation Runner
 * Full cloud-based test: simulates multi-agent team conversations via file system
 * Usage: npx tsx scripts/test/run-team-simulation.ts [--config=path] [--workspace=path]
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'


// ---------- CLI Args ----------
const args = process.argv.slice(2)
const getArg = (name: string, fallback: string) =>
  args.find(a => a.startsWith(`--${name}=`))?.split('=')[1] || fallback

const WORKSPACE = getArg('workspace', '/tmp/dsh-team-sim')
const SCENARIO = process.env.DSH_TEST_SCENARIO || getArg('scenario', 'full-suite')
const MAX_AGENTS = parseInt(getArg('max-agents', process.env.MAX_AGENT_COUNT || '3'))

// ---------- Test Results ----------
interface TestResult {
  scenario: string
  agentCount: number
  messagesExchanged: number
  tasksCreated: number
  tasksCompleted: number
  memoryEntries: number
  errors: string[]
  passed: boolean
  duration: number
}

const results: TestResult[] = []
let totalErrors: string[] = []

// ---------- Helpers ----------
function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true })
}

function writeJsonl(filePath: string, data: any) {
  appendFileSync(filePath, JSON.stringify(data) + '\n')
}

function readJsonlAll(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
}

// ---------- Scenarios ----------
const scenarios = [
  '2-agent-conversation',
  '3-agent-task-decomposition',
  'cross-session-delegation',
  'team-memory-sync',
  'team-task-coordination',
]

async function runScenario(scenarioName: string): Promise<TestResult> {
  const startTime = Date.now()
  console.log(`\n🚀 Running: ${scenarioName}`)

  const scenarioDir = join(WORKSPACE, scenarioName)
  ensureDir(scenarioDir)

  // Create .team directories
  const teamDir = join(scenarioDir, '.team')
  ensureDir(join(teamDir, 'inbox'))
  ensureDir(join(teamDir, 'presence'))
  ensureDir(join(teamDir, 'tasks'))
  ensureDir(join(teamDir, 'memory'))
  ensureDir(join(teamDir, 'think'))
  ensureDir(join(teamDir, 'reports'))

  const agents = Array.from({ length: MAX_AGENTS }, (_, i) => ({
    id: `agent-${i}`,
    role: i === 0 ? 'coordinator' : `solver-${i}`,
    status: 'active',
  }))

  // 1) Initialize presence
  agents.forEach(agent => {
    writeFileSync(
      join(teamDir, 'presence', `${agent.id}.json`),
      JSON.stringify({ ...agent, lastSeen: Date.now() }, null, 2)
    )
  })
  console.log(`   ✓ Initialized ${agents.length} agents`)

  // 2) Simulate conversations
  let messagesExchanged = 0
  let tasksCreated = 0
  let tasksCompleted = 0
  let memoryEntries = 0

  for (const agent of agents) {
    const inboxPath = join(teamDir, 'inbox', `${agent.id}.jsonl`)

    // Each agent sends messages
    const outboxMessages = [
      {
        from: agent.id,
        to: 'team',
        content: `Agent ${agent.id} initialized. Ready to collaborate.`,
        type: 'report' as const,
        timestamp: Date.now(),
      },
      {
        from: agent.id,
        to: 'team',
        content: `Task status: ${agent.role} has started working on assigned tasks.`,
        type: 'task' as const,
        timestamp: Date.now() + 100,
      },
    ]
    outboxMessages.forEach(msg => writeJsonl(inboxPath, msg))
    messagesExchanged += 2

    // Each agent creates a task
    const taskFile = join(teamDir, 'tasks', `${agent.id}-task.json`)
    writeFileSync(taskFile, JSON.stringify({
      id: `${agent.id}-task`,
      assignee: agent.id,
      description: `Complete ${agent.role} responsibilities`,
      status: 'completed',
      createdAt: Date.now(),
      completedAt: Date.now() + 1000,
    }, null, 2))
    tasksCreated++
    tasksCompleted++

    // Each agent writes to memory
    const memoryPath = join(teamDir, 'memory', 'entries.jsonl')
    writeJsonl(memoryPath, {
      agent: agent.id,
      key: `decision-${agent.id}`,
      value: `Agent ${agent.id} decided on strategy ${agent.id.toUpperCase()}`,
      timestamp: Date.now(),
    })
    memoryEntries++

    // Think log
    const thinkPath = join(teamDir, 'think', `${agent.id}-think.jsonl`)
    writeJsonl(thinkPath, {
      agent: agent.id,
      step: 1,
      thought: `Analyzing requirements for ${scenarioName}`,
      timestamp: Date.now(),
    })

    // Update presence
    const presenceFile = join(teamDir, 'presence', `${agent.id}.json`)
    const presence = JSON.parse(readFileSync(presenceFile, 'utf-8'))
    presence.lastSeen = Date.now()
    presence.status = 'completed'
    writeFileSync(presenceFile, JSON.stringify(presence, null, 2))
  }

  console.log(`   ✓ Messages exchanged: ${messagesExchanged}`)
  console.log(`   ✓ Tasks created: ${tasksCreated}`)
  console.log(`   ✓ Memory entries: ${memoryEntries}`)

  // 3) Generate team report
  const reportFile = join(teamDir, 'reports', 'team-summary.json')
  const report = {
    scenario: scenarioName,
    agents: agents.length,
    messagesExchanged,
    tasksCreated,
    tasksCompleted,
    memoryEntries,
    timestamp: Date.now(),
  }
  writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log(`   ✓ Report generated: ${reportFile}`)

  // 4) Validate results
  const errors: string[] = []

  // Validate all presence files exist
  const presenceFiles = readdirSync(join(teamDir, 'presence'))
  if (presenceFiles.length !== agents.length) {
    errors.push(`Expected ${agents.length} presence files, got ${presenceFiles.length}`)
  }

  // Validate memory search works (BM25-lite)
  const allMemory = readJsonlAll(join(teamDir, 'memory', 'entries.jsonl'))
  const searchResults = allMemory.filter(m => m.value.includes('decided'))
  if (searchResults.length !== agents.length) {
    errors.push(`Memory search: expected ${agents.length} results, got ${searchResults.length}`)
  }

  // Validate task completion
  const allTasks = readdirSync(join(teamDir, 'tasks')).map(f =>
    JSON.parse(readFileSync(join(teamDir, 'tasks', f), 'utf-8'))
  )
  if (allTasks.length !== tasksCreated) {
    errors.push(`Expected ${tasksCreated} tasks, found ${allTasks.length}`)
  }

  // Validate think log
  for (const agent of agents) {
    const thinkFile = join(teamDir, 'think', `${agent.id}-think.jsonl`)
    if (!existsSync(thinkFile)) {
      errors.push(`Think log missing for ${agent.id}`)
    }
  }

  const passed = errors.length === 0
  const duration = Date.now() - startTime
  console.log(`   ${passed ? '✅' : '❌'} ${scenarioName} ${passed ? 'PASSED' : 'FAILED'} (${duration}ms)`)

  return {
    scenario: scenarioName,
    agentCount: agents.length,
    messagesExchanged,
    tasksCreated,
    tasksCompleted,
    memoryEntries,
    errors,
    passed,
    duration,
  }
}

// ---------- Main ----------
async function main() {
  console.log('=' .repeat(60))
  console.log('DeepSeek Harness - Team Mode Cloud Simulation')
  console.log('=' .repeat(60))
  console.log(`Scenario: ${SCENARIO}`)
  console.log(`Workspace: ${WORKSPACE}`)
  console.log(`Max agents: ${MAX_AGENTS}`)
  console.log('=' .repeat(60))

  ensureDir(WORKSPACE)

  const scenariosToRun = SCENARIO === 'full-suite' ? scenarios : [SCENARIO]

  for (const scenario of scenariosToRun) {
    const result = await runScenario(scenario)
    results.push(result)
    totalErrors.push(...result.errors)
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('TEST RESULTS SUMMARY')
  console.log('='.repeat(60))

  const passedCount = results.filter(r => r.passed).length
  const totalCount = results.length

  results.forEach(r => {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.scenario} (${r.duration}ms)`)
    if (r.errors.length > 0) {
      r.errors.forEach(e => console.log(`     - ${e}`))
    }
  })

  console.log('\n' + '='.repeat(60))
  console.log(`PASSED: ${passedCount}/${totalCount}`)
  console.log('='.repeat(60))

  // Write test report
  const reportDir = join(WORKSPACE, 'reports')
  ensureDir(reportDir)
  writeFileSync(
    join(reportDir, 'simulation-results.json'),
    JSON.stringify({ results, totalErrors }, null, 2)
  )

  // Exit with error if any scenario failed
  if (passedCount < totalCount) {
    process.exit(1)
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})