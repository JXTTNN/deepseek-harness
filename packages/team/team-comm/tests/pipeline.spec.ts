import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createPipeline,
  readPipeline,
  listPipelines,
  startPipeline,
  advancePipeline,
  failPipeline,
  cancelPipeline,
  deletePipeline,

} from '../src/pipeline'

const TMP = join(tmpdir(), `pipeline-test-${Date.now()}`)

function makeAgent(sessionId: string, cwd: string) {
  return { session: { id: sessionId, header: { cwd } } }
}

describe('pipeline', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  describe('createPipeline', () => {
    it('should create a pipeline with stages', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'deploy-pipeline',
        description: 'Deploy to production',
        stages: [
          { name: 'build', description: 'Build the project' },
          { name: 'test', description: 'Run tests' },
          { name: 'deploy', description: 'Deploy to prod' },
        ],
      })
      expect(p.id).toBeDefined()
      expect(p.name).toBe('deploy-pipeline')
      expect(p.description).toBe('Deploy to production')
      expect(p.stages).toHaveLength(3)
      expect(p.stages[0]!.name).toBe('build')
      expect(p.stages[0]!.status).toBe('pending')
      expect(p.status).toBe('pending')
      expect(p.currentStage).toBe(0)
      expect(p.createdBy).toBe('s1')
    })

    it('should throw if name is missing', () => {
      const agent = makeAgent('s1', TMP)
      expect(() => createPipeline(agent, {
        name: '',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })).toThrow('name required')
    })

    it('should throw if no stages provided', () => {
      const agent = makeAgent('s1', TMP)
      expect(() => createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [],
      })).toThrow('at least one stage')
    })

    it('should support assignedTo for stages', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [
          { name: 's1', description: 'stage 1', assignedTo: 'agent-a' },
          { name: 's2', description: 'stage 2' },
        ],
      })
      expect(p.stages[0]!.assignedTo).toBe('agent-a')
      expect(p.stages[1]!.assignedTo).toBeUndefined()
    })
  })

  describe('readPipeline', () => {
    it('should read a pipeline by id', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      const read = readPipeline(agent, p.id)
      expect(read).toBeDefined()
      expect(read!.id).toBe(p.id)
      expect(read!.name).toBe('test')
    })

    it('should return undefined for non-existent pipeline', () => {
      const agent = makeAgent('s1', TMP)
      expect(readPipeline(agent, 'nonexistent')).toBeUndefined()
    })
  })

  describe('listPipelines', () => {
    it('should return empty when no pipelines exist', () => {
      const agent = makeAgent('s1', TMP)
      expect(listPipelines(agent)).toEqual([])
    })

    it('should list all pipelines', async () => {
      const agent = makeAgent('s1', TMP)
      createPipeline(agent, {
        name: 'p1',
        description: 'first',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      await new Promise(r => setTimeout(r, 2))
      createPipeline(agent, {
        name: 'p2',
        description: 'second',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      const list = listPipelines(agent)
      expect(list).toHaveLength(2)
      expect(list[0]!.name).toBe('p1')
      expect(list[1]!.name).toBe('p2')
    })

    it('should filter by status', () => {
      const agent = makeAgent('s1', TMP)
      const p1 = createPipeline(agent, {
        name: 'p1',
        description: 'first',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      createPipeline(agent, {
        name: 'p2',
        description: 'second',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      startPipeline(agent, p1.id)
      const running = listPipelines(agent, { status: 'running' })
      expect(running).toHaveLength(1)
      expect(running[0]!.name).toBe('p1')
    })

    it('should filter by createdBy', () => {
      const agent1 = makeAgent('s1', TMP)
      const agent2 = makeAgent('s2', TMP)
      createPipeline(agent1, {
        name: 'p1',
        description: 'first',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      createPipeline(agent2, {
        name: 'p2',
        description: 'second',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      const byS1 = listPipelines(agent1, { createdBy: 's1' })
      expect(byS1).toHaveLength(1)
      expect(byS1[0]!.name).toBe('p1')
    })
  })

  describe('startPipeline', () => {
    it('should start a pending pipeline', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      const started = startPipeline(agent, p.id)
      expect(started!.status).toBe('running')
      expect(started!.stages[0]!.status).toBe('running')
      expect(started!.stages[0]!.startedAt).toBeDefined()
    })

    it('should throw if pipeline is already running', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      startPipeline(agent, p.id)
      expect(() => startPipeline(agent, p.id)).toThrow('already running')
    })

    it('should return undefined for non-existent pipeline', () => {
      const agent = makeAgent('s1', TMP)
      expect(startPipeline(agent, 'nonexistent')).toBeUndefined()
    })
  })

  describe('advancePipeline', () => {
    it('should advance to next stage', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [
          { name: 's1', description: 'stage 1' },
          { name: 's2', description: 'stage 2' },
        ],
      })
      startPipeline(agent, p.id)
      const advanced = advancePipeline(agent, p.id, { result: 'done' })
      expect(advanced!.currentStage).toBe(1)
      expect(advanced!.stages[0]!.status).toBe('completed')
      expect(advanced!.stages[0]!.output).toEqual({ result: 'done' })
      expect(advanced!.stages[1]!.status).toBe('running')
      expect(advanced!.stages[1]!.startedAt).toBeDefined()
    })

    it('should complete pipeline when last stage finishes', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      startPipeline(agent, p.id)
      const advanced = advancePipeline(agent, p.id, 'final-output')
      expect(advanced!.status).toBe('completed')
      expect(advanced!.currentStage).toBe(1)
      expect(advanced!.stages[0]!.status).toBe('completed')
      expect(advanced!.stages[0]!.output).toBe('final-output')
    })

    it('should throw if pipeline is not running', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      expect(() => advancePipeline(agent, p.id)).toThrow('not running')
    })

    it('should advance without output', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [
          { name: 's1', description: 'stage 1' },
          { name: 's2', description: 'stage 2' },
        ],
      })
      startPipeline(agent, p.id)
      const advanced = advancePipeline(agent, p.id)
      expect(advanced!.stages[0]!.status).toBe('completed')
      expect(advanced!.stages[0]!.output).toBeUndefined()
    })
  })

  describe('failPipeline', () => {
    it('should fail the current stage', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      startPipeline(agent, p.id)
      const failed = failPipeline(agent, p.id, 'build error')
      expect(failed!.status).toBe('failed')
      expect(failed!.stages[0]!.status).toBe('failed')
      expect(failed!.stages[0]!.error).toBe('build error')
    })

    it('should throw if pipeline is not running', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      expect(() => failPipeline(agent, p.id, 'error')).toThrow('not running')
    })
  })

  describe('cancelPipeline', () => {
    it('should cancel a running pipeline', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [
          { name: 's1', description: 'stage 1' },
          { name: 's2', description: 'stage 2' },
        ],
      })
      startPipeline(agent, p.id)
      const cancelled = cancelPipeline(agent, p.id)
      expect(cancelled!.status).toBe('cancelled')
      expect(cancelled!.stages[1]!.status).toBe('skipped')
    })

    it('should cancel a pending pipeline', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      const cancelled = cancelPipeline(agent, p.id)
      expect(cancelled!.status).toBe('cancelled')
      expect(cancelled!.stages[0]!.status).toBe('skipped')
    })

    it('should throw if pipeline is already completed', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      startPipeline(agent, p.id)
      advancePipeline(agent, p.id)
      expect(() => cancelPipeline(agent, p.id)).toThrow('already completed')
    })
  })

  describe('deletePipeline', () => {
    it('should delete a pipeline', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'test',
        description: 'test',
        stages: [{ name: 's1', description: 'stage 1' }],
      })
      expect(deletePipeline(agent, p.id)).toBe(true)
      expect(readPipeline(agent, p.id)).toBeUndefined()
    })

    it('should return false for non-existent pipeline', () => {
      const agent = makeAgent('s1', TMP)
      expect(deletePipeline(agent, 'nonexistent')).toBe(false)
    })
  })

  describe('full pipeline lifecycle', () => {
    it('should support create → start → advance → complete', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'cicd',
        description: 'CI/CD pipeline',
        stages: [
          { name: 'build', description: 'Build' },
          { name: 'test', description: 'Test' },
          { name: 'deploy', description: 'Deploy' },
        ],
      })
      expect(p.status).toBe('pending')

      const started = startPipeline(agent, p.id)
      expect(started!.status).toBe('running')
      expect(started!.stages[0]!.name).toBe('build')

      const afterBuild = advancePipeline(agent, p.id, { artifact: 'dist/' })
      expect(afterBuild!.currentStage).toBe(1)
      expect(afterBuild!.stages[0]!.output).toEqual({ artifact: 'dist/' })

      const afterTest = advancePipeline(agent, p.id, { testsPassed: 42 })
      expect(afterTest!.currentStage).toBe(2)

      const afterDeploy = advancePipeline(agent, p.id, { url: 'https://app.example.com' })
      expect(afterDeploy!.status).toBe('completed')
      expect(afterDeploy!.stages[2]!.output).toEqual({ url: 'https://app.example.com' })
    })

    it('should support create → start → fail', () => {
      const agent = makeAgent('s1', TMP)
      const p = createPipeline(agent, {
        name: 'cicd',
        description: 'CI/CD pipeline',
        stages: [
          { name: 'build', description: 'Build' },
          { name: 'test', description: 'Test' },
        ],
      })
      startPipeline(agent, p.id)
      const failed = failPipeline(agent, p.id, 'compilation error')
      expect(failed!.status).toBe('failed')
      expect(failed!.stages[0]!.error).toBe('compilation error')
      expect(failed!.stages[1]!.status).toBe('pending')
    })
  })
})