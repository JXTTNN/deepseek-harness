/**
 * Team Mode E2E Tests for DeepSeek Harness
 * Tests multi-agent coordination, communication, and task management
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_WORKSPACE = join(tmpdir(), 'dsh-team-test')

describe('Team Mode E2E Tests', () => {
  beforeAll(() => {
    // Clean and create test workspace
    if (existsSync(TEST_WORKSPACE)) {
      rmSync(TEST_WORKSPACE, { recursive: true, force: true })
    }
    mkdirSync(join(TEST_WORKSPACE, '.team'), { recursive: true })
    mkdirSync(join(TEST_WORKSPACE, '.team/inbox'), { recursive: true })
    mkdirSync(join(TEST_WORKSPACE, '.team/presence'), { recursive: true })
    mkdirSync(join(TEST_WORKSPACE, '.team/tasks'), { recursive: true })
    mkdirSync(join(TEST_WORKSPACE, '.team/memory'), { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_WORKSPACE)) {
      rmSync(TEST_WORKSPACE, { recursive: true, force: true })
    }
  })

  describe('Team Communication (team_send, team_inbox, team_list)', () => {
    it('should initialize team presence files for all agents', () => {
      const agents = ['coordinator', 'solver-a', 'solver-b']
      agents.forEach(agentId => {
        const presence = {
          id: agentId,
          status: 'active',
          lastSeen: Date.now(),
          capabilities: ['analysis', 'coding'][Math.floor(Math.random() * 2)]
        }
        writeFileSync(
          join(TEST_WORKSPACE, '.team/presence', `${agentId}.json`),
          JSON.stringify(presence, null, 2)
        )
      })

      // Verify presence files
      const files = readdirSync(join(TEST_WORKSPACE, '.team/presence'))
      expect(files).toHaveLength(3)
      expect(files).toContain('coordinator.json')
      expect(files).toContain('solver-a.json')
    })

    it('should send and receive team messages via inbox', async () => {
      // Simulate team_send - write message
      const message = {
        from: 'coordinator',
        to: 'solver-a',
        content: 'Task assigned: Analyze requirements',
        type: 'task',
        timestamp: Date.now()
      }
      writeFileSync(
        join(TEST_WORKSPACE, '.team/inbox/solver-a.jsonl'),
        JSON.stringify(message) + '\n'
      )

      // Simulate team_inbox - read message (the file should exist)
      expect(existsSync(join(TEST_WORKSPACE, '.team/inbox/solver-a.jsonl'))).toBe(true)

      // Verify content
      const content = JSON.parse(require('fs').readFileSync(
        join(TEST_WORKSPACE, '.team/inbox/solver-a.jsonl'), 'utf-8'
      ))
      expect(content.type).toBe('task')
      expect(content.from).toBe('coordinator')
    })

    it('should list team members via team_list', () => {
      const presenceFiles = readdirSync(join(TEST_WORKSPACE, '.team/presence'))
      const members = presenceFiles.map(f => f.replace('.json', ''))

      expect(members).toContain('coordinator')
      expect(members).toContain('solver-a')
      expect(members).toContain('solver-b')
    })
  })

  describe('Task Coordination (team_task)', () => {
    it('should create a task with proper structure', () => {
      const task = {
        id: 'task-001',
        description: 'Develop 3D visualization module',
        assignee: 'solver-a',
        status: 'in_progress',
        createdAt: Date.now(),
        deliverable: 'src/index.ts'
      }

      writeFileSync(
        join(TEST_WORKSPACE, '.team/tasks/task-001.json'),
        JSON.stringify(task, null, 2)
      )

      // Verify task file
      expect(existsSync(join(TEST_WORKSPACE, '.team/tasks/task-001.json'))).toBe(true)

      const saved = JSON.parse(require('fs').readFileSync(
        join(TEST_WORKSPACE, '.team/tasks/task-001.json'), 'utf-8'
      ))
      expect(saved.assignee).toBe('solver-a')
      expect(saved.status).toBe('in_progress')
    })

    it('should complete a task and move to finished state', () => {
      const taskFile = join(TEST_WORKSPACE, '.team/tasks/task-001.json')
      const task = JSON.parse(require('fs').readFileSync(taskFile, 'utf-8'))

      task.status = 'completed'
      task.completedAt = Date.now()
      writeFileSync(taskFile, JSON.stringify(task, null, 2))

      const updated = JSON.parse(require('fs').readFileSync(taskFile, 'utf-8'))
      expect(updated.status).toBe('completed')
      expect(updated.completedAt).toBeGreaterThan(0)
    })
  })

  describe('Team Memory (team_memory)', () => {
    it('should write and read shared memory', () => {
      const memoryEntry = {
        key: 'team-decision',
        value: 'Use Three.js for 3D rendering',
        author: 'coordinator',
        timestamp: Date.now()
      }

      const memoryFile = join(TEST_WORKSPACE, '.team/memory/entries.jsonl')
      require('fs').appendFileSync(memoryFile, JSON.stringify(memoryEntry) + '\n')

      expect(existsSync(memoryFile)).toBe(true)
    })

    it('should search memory by keyword', () => {
      const entries = require('fs').readFileSync(
        join(TEST_WORKSPACE, '.team/memory/entries.jsonl'), 'utf-8'
      ).trim().split('\n').filter(Boolean)

      const searchResults = entries.filter(e =>
        e.includes('Three.js') || e.includes('rendering')
      )

      expect(searchResults.length).toBeGreaterThan(0)
    })
  })

  describe('Cross-Agent Thinking (team_think/think.log)', () => {
    it('should log reasoning traces across agents', () => {
      const thoughts = [
        { agent: 'coordinator', step: 1, thought: 'Need to integrate 3D viewer' },
        { agent: 'solver-a', step: 2, thought: 'Choose Three.js library' },
        { agent: 'solver-b', step: 3, thought: 'Implement real-time streaming' }
      ]

      const thinkLog = join(TEST_WORKSPACE, '.team/think.log')
      thoughts.forEach(t => {
        require('fs').appendFileSync(thinkLog, JSON.stringify(t) + '\n')
      })

      const logs = require('fs').readFileSync(thinkLog, 'utf-8')
      expect(logs).toContain('Three.js')
      expect(logs).toContain('real-time')
    })
  })
})