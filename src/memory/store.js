// 5-tier agentic memory store on node:sqlite (Node 22.13+ ships node:sqlite unflagged; it still
// emits one ExperimentalWarning per process). Every memory is anchored to a git commit SHA and to
// the content hashes of the files it was derived from, so a memory can be invalidated the moment
// any anchoring file changes. Tiers:
//   working     - task/swarm scratchpads and cross-worker IPC events (short-lived, per task)
//   episodic    - verified past tasks, evidence, failure modes, ADRs
//   structural  - cross-repo / cross-API dependency graph (api_nodes + api_edges)
//   procedural  - reusable blueprints, adapters and validation scripts (global)
//   alignment   - personal style, architecture taste and learned engineering rules (global)
// Retrieval uses a deterministic inverted term index (memory_terms) rather than FTS so results are
// identical on every SQLite build. Local files are trusted input; this is not a security boundary.
import {DatabaseSync} from 'node:sqlite';
import {appendFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

export const TIERS=['working','episodic','structural','procedural','alignment'];
import {canonical,sha256,estimateTokens,tokenize,STOP_WORDS} from '../kernel/util.js';
export {canonical,sha256,estimateTokens,tokenize,STOP_WORDS};

export const DDL=`
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
`;

const now=()=>new Date().toISOString();
export class MemoryStore {
  constructor(path=':memory:'){
    this.path=path;
    this.db=new DatabaseSync(path);
    this.db.exec(DDL);
    this.q={
      upsert:this.db.prepare(`INSERT INTO memories(tier,kind,key,title,content,data,repo,task_id,anchor_sha,tokens,strength,valid,invalid_reason,content_sha256,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?,?)
        ON CONFLICT(tier,key) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,data=excluded.data,repo=excluded.repo,task_id=excluded.task_id,
          anchor_sha=excluded.anchor_sha,tokens=excluded.tokens,strength=memories.strength+1,valid=1,invalid_reason=NULL,content_sha256=excluded.content_sha256,updated_at=excluded.updated_at
        RETURNING id`),
      byKey:this.db.prepare('SELECT * FROM memories WHERE tier=? AND key=?'),
      byId:this.db.prepare('SELECT * FROM memories WHERE id=?'),
      delFiles:this.db.prepare('DELETE FROM memory_files WHERE memory_id=?'),
      addFile:this.db.prepare('INSERT INTO memory_files(memory_id,path,sha256) VALUES(?,?,?)'),
      delTerms:this.db.prepare('DELETE FROM memory_terms WHERE memory_id=?'),
      addTerm:this.db.prepare('INSERT INTO memory_terms(memory_id,term,weight) VALUES(?,?,?)'),
      termDocs:this.db.prepare('SELECT COUNT(*) AS n FROM memory_terms WHERE term=?'),
      total:this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE valid=1'),
      strongest:this.db.prepare('SELECT * FROM memories WHERE tier=? AND valid=1 AND (repo IS NULL OR repo=?) ORDER BY strength DESC,updated_at DESC,id ASC LIMIT ?'),
      invalidate:this.db.prepare('UPDATE memories SET valid=0,invalid_reason=?,updated_at=? WHERE id=? AND valid=1'),
      anchored:this.db.prepare('SELECT m.id,f.path,f.sha256 FROM memories m JOIN memory_files f ON f.memory_id=m.id WHERE m.valid=1 AND (m.repo IS NULL OR m.repo=?)'),
      files:this.db.prepare('SELECT path,sha256 FROM memory_files WHERE memory_id=? ORDER BY path'),
      node:this.db.prepare(`INSERT INTO api_nodes(id,kind,repo,path,sha256,anchor_sha,data,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,repo=COALESCE(excluded.repo,api_nodes.repo),path=COALESCE(excluded.path,api_nodes.path),sha256=COALESCE(excluded.sha256,api_nodes.sha256),anchor_sha=COALESCE(excluded.anchor_sha,api_nodes.anchor_sha),data=COALESCE(excluded.data,api_nodes.data),updated_at=excluded.updated_at`),
      edge:this.db.prepare('INSERT OR REPLACE INTO api_edges(from_id,to_id,kind,evidence,anchor_sha) VALUES(?,?,?,?,?)'),
      dependents:this.db.prepare('SELECT from_id AS id,kind FROM api_edges WHERE to_id=?'),
      dependencies:this.db.prepare('SELECT to_id AS id,kind FROM api_edges WHERE from_id=?'),
      getNode:this.db.prepare('SELECT * FROM api_nodes WHERE id=?'),
      episode:this.db.prepare('INSERT OR IGNORE INTO episodes(episode_id,task_id,repo,kind,outcome,summary,evidence_sha256,anchor_sha,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
      delta:this.db.prepare('INSERT OR IGNORE INTO hitl_deltas(delta_id,task_id,repo,kind,rule_key,payload,created_at) VALUES(?,?,?,?,?,?,?)'),
      pendingDeltas:this.db.prepare('SELECT * FROM hitl_deltas WHERE consolidated=0 ORDER BY rowid'),
      ruleCount:this.db.prepare('SELECT COUNT(DISTINCT COALESCE(task_id,delta_id)) AS n FROM hitl_deltas WHERE rule_key=?'),
      markDelta:this.db.prepare('UPDATE hitl_deltas SET consolidated=1,consolidated_at=? WHERE delta_id=?'),
      log:this.db.prepare('INSERT INTO consolidation_log(run_id,action,target,details,created_at) VALUES(?,?,?,?,?)'),
      logs:this.db.prepare('SELECT * FROM consolidation_log WHERE run_id=? ORDER BY id'),
    };
  }
  transaction(fn){this.db.exec('BEGIN');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  /** Insert or refresh a memory. `files` anchors it to content hashes; re-remembering reinforces strength. */
  remember({tier,kind,key,title,content,data=null,repo=null,taskId=null,anchorSha=null,files=[],tags=[]}){
    if(!TIERS.includes(tier))throw Error(`Unknown memory tier: ${tier}`);
    if(!kind||!key||!title||typeof content!=='string')throw Error('remember requires kind, key, title and string content');
    const ts=now();
    return this.transaction(()=>{
      const {id}=this.q.upsert.get(tier,kind,key,title,content,data===null?null:canonical(data),repo,taskId,anchorSha,estimateTokens(content),1,sha256(content),ts,ts);
      this.q.delFiles.run(id);for(const f of files){if(!/^[a-f0-9]{64}$/.test(f.sha256))throw Error(`Bad anchor hash for ${f.path}`);this.q.addFile.run(id,f.path,f.sha256);}
      this.q.delTerms.run(id);
      const terms=tokenize(`${title} ${title} ${key} ${tags.join(' ')} ${content}`);
      for(const [term,count] of terms)this.q.addTerm.run(id,term,1+Math.log(count));
      return id;
    });
  }
  get(tier,key){const row=this.q.byKey.get(tier,key);return row?this.#hydrate(row):null;}
  #hydrate(row){return {...row,data:row.data?JSON.parse(row.data):null,valid:Boolean(row.valid),files:this.q.files.all(row.id)};}
  /** Ranked recall: tf-idf-ish over the inverted index, boosted by strength, filtered by tier/repo/anchor. */
  recall({tiers=TIERS,terms,query,repo=null,anchorSha=null,kinds=null,limit=10,includeStale=false}={}){
    const tokens=terms??[...tokenize(query??'').keys()];
    if(!tokens.length)return [];
    const total=Math.max(1,this.q.total.get().n);
    const placeholders=tokens.map(()=>'?').join(',');
    const rows=this.db.prepare(`SELECT m.*, t.term, t.weight FROM memory_terms t JOIN memories m ON m.id=t.memory_id
      WHERE t.term IN (${placeholders}) AND m.tier IN (${tiers.map(()=>'?').join(',')}) ${includeStale?'':'AND m.valid=1'}
      ${repo?'AND (m.repo IS NULL OR m.repo=?)':''} ${kinds?`AND m.kind IN (${kinds.map(()=>'?').join(',')})`:''}`)
      .all(...tokens,...tiers,...(repo?[repo]:[]),...(kinds??[]));
    const scores=new Map();
    for(const row of rows){
      const idf=Math.log(1+total/Math.max(1,this.q.termDocs.get(row.term).n));
      const entry=scores.get(row.id)??{row,score:0,matched:new Set()};
      entry.score+=row.weight*idf;entry.matched.add(row.term);scores.set(row.id,entry);
    }
    return [...scores.values()].map(e=>({...this.#hydrate(e.row),score:e.score*(1+Math.log(e.row.strength))*(anchorSha&&e.row.anchor_sha===anchorSha?1.25:1)*(e.matched.size/tokens.length+0.5),matched:[...e.matched].sort()}))
      .sort((a,b)=>b.score-a.score||a.id-b.id).slice(0,limit);
  }
  /** Most reinforced valid memories of a tier (global + repo); used when term recall finds nothing. */
  strongest(tier,{repo=null,limit=5}={}){return this.q.strongest.all(tier,repo,limit).map(r=>({...this.#hydrate(r),score:0,matched:[]}));}
  invalidate(id,reason='manual'){return this.q.invalidate.run(reason,now(),id).changes;}
  /** Invalidate every memory whose anchored file hash differs from the current hash. `current` maps path -> sha256 (missing path = deleted). */
  invalidateStale(current,{repo=null,reason='anchor changed'}={}){
    const lookup=typeof current==='function'?current:p=>current instanceof Map?current.get(p):current[p];
    const stale=new Map();
    for(const r of this.q.anchored.all(repo)){const h=lookup(r.path);if(h!==r.sha256)stale.set(r.id,`${reason}: ${r.path}`);}
    return this.transaction(()=>{let n=0;for(const [id,why] of stale)n+=this.q.invalidate.run(why,now(),id).changes;return {invalidated:n,ids:[...stale.keys()].sort((a,b)=>a-b)};});
  }
  // ---- structural memory --------------------------------------------------------------------
  node({id,kind,repo=null,path=null,sha256:hash=null,anchorSha=null,data=null}){this.q.node.run(id,kind,repo,path,hash,anchorSha,data===null?null:canonical(data),now());return id;}
  link({from,to,kind='depends_on',evidence=null,anchorSha=null}){
    if(!this.q.getNode.get(from))this.node({id:from,kind:from.split(':')[0]==='endpoint'?'endpoint':'module'});
    if(!this.q.getNode.get(to))this.node({id:to,kind:to.split(':')[0]==='endpoint'?'endpoint':'module'});
    this.q.edge.run(from,to,kind,evidence,anchorSha);
  }
  /** Everything transitively affected when `id` changes (reverse BFS over api_edges). */
  impacted(id,{maxDepth=6}={}){
    const seen=new Map([[id,0]]),queue=[id],out=[];
    while(queue.length){const cur=queue.shift(),d=seen.get(cur);if(d>=maxDepth)continue;
      for(const dep of this.q.dependents.all(cur)){if(seen.has(dep.id))continue;seen.set(dep.id,d+1);out.push({id:dep.id,via:cur,kind:dep.kind,depth:d+1});queue.push(dep.id);}}
    return out.sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id));
  }
  dependencies(id){return this.q.dependencies.all(id).sort((a,b)=>a.id.localeCompare(b.id));}
  getNode(id){const n=this.q.getNode.get(id);return n?{...n,data:n.data?JSON.parse(n.data):null}:null;}
  // ---- episodic / HITL -------------------------------------------------------------------------
  async recordEpisode({episodeId,taskId=null,repo=null,kind,outcome,summary,evidenceSha256=null,anchorSha=null,data=null,jsonlPath=null}){
    const record={episodeId,taskId,repo,kind,outcome,summary,evidenceSha256,anchorSha,data,createdAt:now()};
    const inserted=this.q.episode.run(episodeId,taskId,repo,kind,outcome,summary,evidenceSha256,anchorSha,data===null?null:canonical(data),record.createdAt).changes;
    if(inserted&&jsonlPath){await mkdir(dirname(jsonlPath),{recursive:true});await appendFile(jsonlPath,canonical(record)+'\n');}
    return record;
  }
  episodes({taskId=null,kind=null,limit=50}={}){
    return this.db.prepare(`SELECT * FROM episodes WHERE 1=1 ${taskId?'AND task_id=?':''} ${kind?'AND kind=?':''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(taskId?[taskId]:[]),...(kind?[kind]:[]),limit).map(e=>({...e,data:e.data?JSON.parse(e.data):null}));
  }
  recordDelta(delta){return this.q.delta.run(delta.deltaId,delta.taskId??null,delta.repo??null,delta.kind,delta.ruleKey??null,canonical(delta),delta.createdAt??now()).changes;}
  pendingDeltas(){return this.q.pendingDeltas.all().map(d=>({...d,payload:JSON.parse(d.payload)}));}
  ruleOccurrences(ruleKey){return this.q.ruleCount.get(ruleKey).n;}
  markConsolidated(deltaIds){const ts=now();return this.transaction(()=>deltaIds.reduce((n,id)=>n+this.q.markDelta.run(ts,id).changes,0));}
  logConsolidation(runId,action,target,details=null){this.q.log.run(runId,action,target,details===null?null:canonical(details),now());}
  consolidationLog(runId){return this.q.logs.all(runId).map(l=>({...l,details:l.details?JSON.parse(l.details):null}));}
  stats(){
    const byTier=Object.fromEntries(TIERS.map(t=>[t,this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE tier=? AND valid=1').get(t).n]));
    return {byTier,stale:this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE valid=0').get().n,nodes:this.db.prepare('SELECT COUNT(*) AS n FROM api_nodes').get().n,edges:this.db.prepare('SELECT COUNT(*) AS n FROM api_edges').get().n,pendingDeltas:this.db.prepare('SELECT COUNT(*) AS n FROM hitl_deltas WHERE consolidated=0').get().n};
  }
  close(){this.db.close();}
}
export function openStore(path){return new MemoryStore(path);}
