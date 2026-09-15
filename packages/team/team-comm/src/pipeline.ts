/**
 * Pipeline module — linear sequential task execution.
 *
 * A pipeline is a series of stages that execute in order. Each stage must
 * complete before the next begins. The output of one stage can be referenced
 * by the next stage. This is simpler than a DAG workflow and is ideal for
 * sequential task chains like: analyze → plan → implement → test → deploy.
 *
 * @module @deepseek-ai/dsh-team-comm/pipeline
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

// -- Constants ------------------------------------------------------------

/** Pipeline directory name within .team/ */
const PIPELINE_DIR = 'pipelines'

// -- Types ----------------------------------------------------------------

/** Stage status within a pipeline. */
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** Pipeline status. */
export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** One stage in a pipeline. */
export interface PipelineStage {
  id: string
  name: string
  description: string
  status: StageStatus
  assignedTo?: string
  output?: unknown
  error?: string
  startedAt?: string
  completedAt?: string
}

/** A linear pipeline definition. */
export interface Pipeline {
  id: string
  name: string
  description: string
  stages: PipelineStage[]
  status: PipelineStatus
  currentStage: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** Input for creating a pipeline stage. */
export interface PipelineStageInput {
  name: string
  description: string
  assignedTo?: string
}

/** Input for creating a pipeline. */
export interface PipelineCreateInput {
  name: string
  description: string
  stages: PipelineStageInput[]
}

// -- Helpers --------------------------------------------------------------

function pipelineDir(agent: { session: { header?: { cwd?: string } } }): string {
  return join(teamCwd(agent), TEAM_DIR, PIPELINE_DIR)
}

function pipelineFile(agent: { session: { header?: { cwd?: string } } }, id: string): string {
  return join(pipelineDir(agent), `${id}.json`)
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

// -- CRUD -----------------------------------------------------------------

/** Create a new pipeline with the given stages. */
export function createPipeline(
  agent: { session: { id: string; header?: { cwd?: string } } },
  input: PipelineCreateInput,
): Pipeline {
  if (!input.name) throw new Error('createPipeline: name required')
  if (!input.stages || input.stages.length === 0) throw new Error('createPipeline: at least one stage required')

  const dir = pipelineDir(agent)
  mkdirSync(dir, { recursive: true })

  const now = new Date().toISOString()
  const pipeline: Pipeline = {
    id: randomUUID().slice(0, 8),
    name: input.name,
    description: input.description,
    stages: input.stages.map((s, i) => ({
      id: `stage-${i + 1}`,
      name: s.name,
      description: s.description,
      status: 'pending' as StageStatus,
      ...(s.assignedTo !== undefined ? { assignedTo: s.assignedTo } : {}),
    })),
    status: 'pending',
    currentStage: 0,
    createdBy: agent.session.id,
    createdAt: now,
    updatedAt: now,
  }

  atomicWrite(pipelineFile(agent, pipeline.id), JSON.stringify(pipeline, null, 2))
  return pipeline
}

/** Read a pipeline by id. */
export function readPipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): Pipeline | undefined {
  const file = pipelineFile(agent, id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Pipeline
  } catch {
    return undefined
  }
}

/** List all pipelines, optionally filtered by status. */
export function listPipelines(
  agent: { session: { header?: { cwd?: string } } },
  filter?: { status?: PipelineStatus; createdBy?: string },
): Pipeline[] {
  const dir = pipelineDir(agent)
  if (!existsSync(dir)) return []
  const pipelines: Pipeline[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Pipeline
      if (filter) {
        if (filter.status && p.status !== filter.status) continue
        if (filter.createdBy && p.createdBy !== filter.createdBy) continue
      }
      pipelines.push(p)
    } catch {
      // skip corrupted
    }
  }
  return pipelines.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt)
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id)
  })
}

/** Start a pipeline (transition from pending to running). */
export function startPipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): Pipeline | undefined {
  const pipeline = readPipeline(agent, id)
  if (!pipeline) return undefined
  if (pipeline.status !== 'pending') throw new Error(`Pipeline ${id} is already ${pipeline.status}`)
  if (pipeline.stages.length === 0) throw new Error(`Pipeline ${id} has no stages`)

  pipeline.status = 'running'
  pipeline.stages[0]!.status = 'running'
  pipeline.stages[0]!.startedAt = new Date().toISOString()
  pipeline.updatedAt = new Date().toISOString()

  atomicWrite(pipelineFile(agent, id), JSON.stringify(pipeline, null, 2))
  return pipeline
}

/** Advance the pipeline: mark current stage as completed and start the next. */
export function advancePipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  output?: unknown,
): Pipeline | undefined {
  const pipeline = readPipeline(agent, id)
  if (!pipeline) return undefined
  if (pipeline.status !== 'running') throw new Error(`Pipeline ${id} is not running (status: ${pipeline.status})`)
  if (pipeline.currentStage >= pipeline.stages.length) throw new Error(`Pipeline ${id} has no more stages`)

  const now = new Date().toISOString()
  const current = pipeline.stages[pipeline.currentStage]!
  current.status = 'completed'
  current.completedAt = now
  if (output !== undefined) current.output = output

  pipeline.currentStage++

  if (pipeline.currentStage >= pipeline.stages.length) {
    // All stages completed
    pipeline.status = 'completed'
  } else {
    // Start next stage
    const next = pipeline.stages[pipeline.currentStage]!
    next.status = 'running'
    next.startedAt = now
  }

  pipeline.updatedAt = now
  atomicWrite(pipelineFile(agent, id), JSON.stringify(pipeline, null, 2))
  return pipeline
}

/** Fail the current stage and mark the pipeline as failed. */
export function failPipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
  error: string,
): Pipeline | undefined {
  const pipeline = readPipeline(agent, id)
  if (!pipeline) return undefined
  if (pipeline.status !== 'running') throw new Error(`Pipeline ${id} is not running`)

  const now = new Date().toISOString()
  const current = pipeline.stages[pipeline.currentStage]!
  current.status = 'failed'
  current.error = error
  current.completedAt = now

  pipeline.status = 'failed'
  pipeline.updatedAt = now

  atomicWrite(pipelineFile(agent, id), JSON.stringify(pipeline, null, 2))
  return pipeline
}

/** Cancel a pipeline (only if not completed). */
export function cancelPipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): Pipeline | undefined {
  const pipeline = readPipeline(agent, id)
  if (!pipeline) return undefined
  if (pipeline.status === 'completed') throw new Error(`Pipeline ${id} is already completed`)

  pipeline.status = 'cancelled'
  pipeline.updatedAt = new Date().toISOString()

  // Mark remaining stages as skipped
  for (let i = pipeline.currentStage; i < pipeline.stages.length; i++) {
    if (pipeline.stages[i]!.status === 'pending') {
      pipeline.stages[i]!.status = 'skipped'
    }
  }

  atomicWrite(pipelineFile(agent, id), JSON.stringify(pipeline, null, 2))
  return pipeline
}

/** Delete a pipeline. */
export function deletePipeline(
  agent: { session: { header?: { cwd?: string } } },
  id: string,
): boolean {
  const file = pipelineFile(agent, id)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}