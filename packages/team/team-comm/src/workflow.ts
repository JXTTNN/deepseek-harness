/**
 * Workflow DAG execution engine helpers.
 *
 * Extracted from index.ts for module separation. Contains types and
 * helper functions for the team_workflow tool.
 *
 * @module @deepseek-ai/dsh-team-comm/workflow
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_DIR, teamCwd } from './shared'

/** F3: One node in a workflow DAG. */
export interface WorkflowNode {
  id: string
  task_description: string
  deps: string[]
  parallel?: boolean
}

/** F3: One edge in a workflow DAG (optional, for conditional transitions). */
export interface WorkflowEdge {
  from: string
  to: string
  condition?: string
}

/** F3: The persistent state of a workflow. */
export interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges?: WorkflowEdge[]
  nodeStatus: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>
  taskIds: Record<string, string>
  createdBy: string
  ts: string
  updatedTs: string
}

/** F3: Read a workflow state file. */
export function readWorkflow(agent: { session: { header?: { cwd?: string } } }, name: string): WorkflowState | undefined {
  const file = join(teamCwd(agent), TEAM_DIR, 'workflows', `${name}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as WorkflowState
  } catch {
    return undefined
  }
}

/** F3: Write a workflow state file atomically. */
export function writeWorkflow(agent: { session: { header?: { cwd?: string } } }, state: WorkflowState): void {
  const dir = join(teamCwd(agent), TEAM_DIR, 'workflows')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${state.name}.json`)
  writeFileSync(file, JSON.stringify(state, null, 2))
}

/** F3: Check if all deps of a node are completed. */
export function isNodeReady(node: WorkflowNode, state: WorkflowState): boolean {
  return node.deps.every(depId => state.nodeStatus[depId] === 'completed')
}
