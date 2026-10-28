-- Synthetic Hermes state.db seed (synthetic physical schema v1; real stores never inspected).
-- Materialized by tests into mkdtemp via better-sqlite3 with __WORKSPACE__ and
-- __OTHER_WORKSPACE__ replaced by real temporary directories. WAL mode is
-- intentional: committed rows may still live in state.db-wal so tests prove the
-- backup API (not a file copy) produces the consistent snapshot.
PRAGMA journal_mode=WAL;

CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES ('native_schema', 'hermes-synthetic-v1');

CREATE TABLE sessions(
  id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'cli',
  user_id TEXT, model TEXT, model_config TEXT,
  parent_session_id TEXT, compressed_from_session_id TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, inactive INTEGER NOT NULL DEFAULT 0,
  cwd TEXT, git_branch TEXT, routing_key TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, billing_provider TEXT,
  export_deleted_at INTEGER, provider_deleted_at INTEGER
);

CREATE TABLE messages(
  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_call_id TEXT, tool_calls TEXT,
  tool_name TEXT, timestamp INTEGER, token_count INTEGER,
  finish_reason TEXT, reasoning TEXT, reasoning_content TEXT,
  reasoning_details TEXT, codex_reasoning_items TEXT,
  PRIMARY KEY(session_id, seq)
);

INSERT INTO sessions(id, source, user_id, model, model_config, parent_session_id,
  compressed_from_session_id, started_at, ended_at, end_reason, archived, inactive,
  cwd, git_branch, routing_key, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd,
  billing_provider, export_deleted_at, provider_deleted_at)
VALUES('hermes-ws-1', 'cli', 'synthetic-user', 'synthetic/model', NULL, NULL,
  NULL, 1785153600, 1785153660, 'completed', 0, 0,
  '__WORKSPACE__', 'feature/synthetic', 'agent:main:cli:synthetic', 100, 50, 20,
  5, 10, 0.12, 0.1,
  'synthetic', NULL, NULL);

INSERT INTO messages(session_id, seq, id, role, content, tool_call_id, tool_calls,
  tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content,
  reasoning_details, codex_reasoning_items)
VALUES('hermes-ws-1', 0, 'm1', 'user', '"Inspect synthetic evidence"', NULL, NULL,
  NULL, 1785153601, 4, NULL, NULL, NULL,
  NULL, NULL);
INSERT INTO messages(session_id, seq, id, role, content, tool_call_id, tool_calls,
  tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content,
  reasoning_details, codex_reasoning_items)
VALUES('hermes-ws-1', 1, 'm2', 'assistant', '"Evidence inspected"', NULL,
  '[{"id":"tool-1","function":{"name":"session_search","arguments":"{}"}}]',
  NULL, 1785153602, 6, 'tool_calls', NULL, NULL,
  NULL, NULL);
INSERT INTO messages(session_id, seq, id, role, content, tool_call_id, tool_calls,
  tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content,
  reasoning_details, codex_reasoning_items)
VALUES('hermes-ws-1', 2, 'm3', 'tool', '[{"type":"text","text":"opaque tool output"}]', 'tool-1', NULL,
  'session_search', 1785153603, NULL, NULL, NULL, NULL,
  NULL, NULL);

INSERT INTO sessions(id, source, user_id, model, model_config, parent_session_id,
  compressed_from_session_id, started_at, ended_at, end_reason, archived, inactive,
  cwd, git_branch, routing_key, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd,
  billing_provider, export_deleted_at, provider_deleted_at)
VALUES('hermes-other-1', 'cli', 'synthetic-user', 'synthetic/model', NULL, NULL,
  NULL, 1785153700, NULL, NULL, 0, 0,
  '__OTHER_WORKSPACE__', NULL, NULL, 10, 5, 0,
  0, 0, NULL, NULL,
  NULL, NULL, NULL);

INSERT INTO messages(session_id, seq, id, role, content, tool_call_id, tool_calls,
  tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content,
  reasoning_details, codex_reasoning_items)
VALUES('hermes-other-1', 0, 'm1', 'user', '"Another workspace session; must never attach elsewhere."', NULL, NULL,
  NULL, 1785153701, 2, NULL, NULL, NULL,
  NULL, NULL);

INSERT INTO sessions(id, source, user_id, model, model_config, parent_session_id,
  compressed_from_session_id, started_at, ended_at, end_reason, archived, inactive,
  cwd, git_branch, routing_key, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd,
  billing_provider, export_deleted_at, provider_deleted_at)
VALUES('hermes-nocwd-1', 'cli', NULL, NULL, NULL, NULL,
  NULL, 1785153800, NULL, NULL, 0, 0,
  NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL);

INSERT INTO messages(session_id, seq, id, role, content, tool_call_id, tool_calls,
  tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content,
  reasoning_details, codex_reasoning_items)
VALUES('hermes-nocwd-1', 0, 'm1', 'user', '"A session with no workspace binding stays excluded."', NULL, NULL,
  NULL, 1785153801, 1, NULL, NULL, NULL,
  NULL, NULL);
