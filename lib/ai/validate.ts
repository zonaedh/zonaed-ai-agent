// ============================================================================
// Shared request payload types for /api/chat (client + server contract).
// Validation of the actual payload lives in the route; this module only pins
// the shape so the client and server cannot drift.
// ============================================================================

export interface PreambleShape {
  skills: { title: string; content: string }[];
  memories: { category: string; content: string }[];
  examples: { input: string; output: string }[];
}
