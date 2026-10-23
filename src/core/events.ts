// Schéma d'événements commun à tous les adaptateurs.
import type { AgentId } from './types';

/** Agent + modèle + effort d'un thread à un instant donné. */
export interface AgentRef {
  agent: AgentId;
  model?: string;
  effort?: string;
}

export type AgentEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'user_text'; text: string }
  | { type: 'assistant_text'; text: string; partial: boolean }
  | { type: 'tool_call'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; id?: string; name: string; output: unknown; isError?: boolean }
  | { type: 'file_changed'; path: string }
  | { type: 'usage'; tokens: number; cost?: number }
  | { type: 'scope_violation'; path: string }
  | { type: 'commit_violation'; oldHead: string; newHead: string }
  | { type: 'commit_made'; sha: string; message: string; paths: string[] }
  | { type: 'agent_switched'; from: AgentRef; to: AgentRef; mode: 'resume' | 'handoff' }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

export type AgentEventType = AgentEvent['type'];

/** Événement horodaté tel qu'il est stocké dans le ThreadStore. */
export interface StoredEvent {
  ts: number;
  event: AgentEvent;
}

/** Ligne brute d'un CLI, gardée pour le débogage. */
export interface RawLine {
  ts: number;
  stream: 'stdout' | 'stderr';
  line: string;
}
