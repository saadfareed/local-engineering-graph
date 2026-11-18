-- Generated from src/memory/store.js (DDL constant). Regenerate with: node scripts/meta-os-ddl.js
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('working','episodic','structural','procedural','alignment')),
  kind TEXT NOT NULL,                 -- scratchpad|ipc|episode|adr|failure|blueprint|adapter|script|preference|rule|endpoint
  key TEXT NOT NULL,                  -- stable logical key (e.g. "adr:0007", "endpoint:orders.create", "rule:no-n-plus-one")
  title TEXT NOT NULL,
  content TEXT NOT NULL,              -- Markdown or JSON text handed to the context compiler
  data TEXT,                          -- optional tier-specific JSON payload
  repo TEXT,                          -- repository identity (remote URL or absolute root); NULL = global
  task_id TEXT,
  anchor_sha TEXT,                    -- git commit the memory was verified against
  tokens INTEGER NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0, -- reinforcement count / confidence used for ranking
  valid INTEGER NOT NULL DEFAULT 1,
  invalid_reason TEXT,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tier, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_tier_valid ON memories(tier, valid);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo);
CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(task_id);
-- File anchors: any change to an anchored file's content hash invalidates the memory.
CREATE TABLE IF NOT EXISTS memory_files (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (memory_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memory_files_path ON memory_files(path);
-- Deterministic inverted index for recall.
CREATE TABLE IF NOT EXISTS memory_terms (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (memory_id, term)
);
CREATE INDEX IF NOT EXISTS idx_memory_terms_term ON memory_terms(term);
-- Structural memory: cross-repo, cross-API dependency graph.
CREATE TABLE IF NOT EXISTS api_nodes (
  id TEXT PRIMARY KEY,                -- "endpoint:orders.create" | "model:Order" | "serializer:OrderIn" | "service:PricingService" | "repo:billing"
  kind TEXT NOT NULL CHECK (kind IN ('endpoint','model','schema','service','repository','module','adapter','policy','external')),
  repo TEXT,
  path TEXT,                          -- file path when the node is a code artifact
  sha256 TEXT,                        -- content hash of that file at last sync
  anchor_sha TEXT,
  data TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_edges (
  from_id TEXT NOT NULL REFERENCES api_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES api_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calls','reads','writes','serializes','validates','depends_on','implements','documents','tests')),
  evidence TEXT,                      -- spec.md scenario row / AST checker output that established the edge
  anchor_sha TEXT,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_api_edges_to ON api_edges(to_id);
-- Episodic log mirror (the JSONL file is the truth; this table is the query index).
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  repo TEXT,
  kind TEXT NOT NULL,                 -- task_verified|task_failed|adr|review_finding|swarm_unit
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_sha256 TEXT,
  anchor_sha TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
-- HITL delta records awaiting / completed sleep-cycle consolidation.
CREATE TABLE IF NOT EXISTS hitl_deltas (
  delta_id TEXT PRIMARY KEY,
  task_id TEXT,
  repo TEXT,
  kind TEXT NOT NULL,                 -- decision_card_answer|spec_edit|plan_edit|review_rejection|preference
  rule_key TEXT,                      -- normalized rule used for repeated-feedback promotion
  payload TEXT NOT NULL,
  consolidated INTEGER NOT NULL DEFAULT 0,
  consolidated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hitl_rule ON hitl_deltas(rule_key, consolidated);
CREATE TABLE IF NOT EXISTS consolidation_log (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- adr_created|rule_promoted|blueprint_extracted|preference_recorded|episode_recorded
  target TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
