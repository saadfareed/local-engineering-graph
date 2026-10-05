export function validateGraph(g) {
  if (!g || typeof g.id !== 'string' || !Number.isInteger(g.version) || g.version < 1 || !g.nodes || !Array.isArray(g.edges)) throw Error('Invalid graph header');
  if (g.evidenceMode !== undefined && g.evidenceMode !== 'structured') throw Error('Invalid evidence mode');
  if (g.criticalPlanning !== undefined && typeof g.criticalPlanning !== 'boolean') throw Error('Invalid critical planning setting');
  if (g.criticalPlanning && !g.engineeringQuality) throw Error('Critical planning requires engineering quality');
  if (g.engineeringQuality !== undefined && typeof g.engineeringQuality !== 'boolean') throw Error('Invalid engineering quality setting');
  if (g.engineeringQuality && g.evidenceMode !== 'structured') throw Error('Engineering quality requires structured evidence');
  if (g.productPreparation !== undefined && typeof g.productPreparation !== 'boolean') throw Error('Invalid product preparation setting');
  if (g.productPreparation && !g.productMap) throw Error('Product preparation requires product map');
  if (g.productMap !== undefined && typeof g.productMap !== 'boolean') throw Error('Invalid product map setting');
  if (g.productMap && g.evidenceMode !== 'structured') throw Error('Product map requires structured evidence');
  if (!Array.isArray(g.requiredGates??[]) || new Set(g.requiredGates??[]).size!==(g.requiredGates??[]).length) throw Error('Invalid required gates');
  if (!Object.values(g.nodes).some(n=>n?.type==='terminal'&&n.success===true)) throw Error('Successful terminal required');
  if (!g.nodes[g.start]) throw Error('Missing start node');
  for (const [id,n] of Object.entries(g.nodes)) {
    if(!id||id.includes(':')||['__proto__','constructor','prototype'].includes(id))throw Error(`Invalid node ID: ${id}`);
    if (!n || typeof n!=='object') throw Error(`Invalid node: ${id}`);
    if (n.success!==undefined && (typeof n.success!=='boolean'||n.type!=='terminal')) throw Error('Success is only valid on terminals');
    if (!['agent','approval','terminal'].includes(n.type)) throw Error(`Invalid node type: ${id}`);
    if (!Array.isArray(n.outcomes) || n.outcomes.some(o=>typeof o!=='string'||!o.trim()) || new Set(n.outcomes).size !== n.outcomes.length) throw Error(`Invalid outcomes: ${id}`);
    if(n.type!=='terminal'&&(typeof n.role!=='string'||!n.role.trim()))throw Error(`Role required: ${id}`);
    if(n.type==='agent'&&n.role==='user'||n.type==='approval'&&n.role!=='user')throw Error(`Invalid role for node type: ${id}`);
    if(n.outcomes.some(o=>o==='cancelled'||o.includes(':')))throw Error(`Reserved or invalid outcome: ${id}`);
    if (n.type === 'terminal' && n.outcomes.length) throw Error('Terminal has outcomes');
    if (n.type !== 'terminal' && !n.outcomes.length) throw Error('Nonterminal needs outcomes');
    if (n.submissionOutcome !== undefined && !n.outcomes.includes(n.submissionOutcome)) throw Error(`Invalid submission outcome: ${id}`);
    for (const outcome of n.outcomes) if (g.edges.filter(e=>e.from===id && e.outcome===outcome).length!==1) throw Error(`Outcome must have exactly one edge: ${id}.${outcome}`);
  }
  for (const e of g.edges) {
    if (!g.nodes[e.from] || !g.nodes[e.to] || !g.nodes[e.from].outcomes.includes(e.outcome)) throw Error('Invalid edge');
    if (!Number.isInteger(e.maxTraversals) || e.maxTraversals<1) throw Error('Every edge needs a positive traversal budget');
  }
  const visited=new Set(); const walk=id=>{if(visited.has(id))return;visited.add(id);g.edges.filter(e=>e.from===id).forEach(e=>walk(e.to));};walk(g.start);
  if(visited.size!==Object.keys(g.nodes).length) throw Error('Unreachable node');
  const terminating=new Set(Object.keys(g.nodes).filter(id=>g.nodes[id].type==='terminal'));
  let changed=true;
  while(changed){changed=false;for(const e of g.edges)if(terminating.has(e.to)&&!terminating.has(e.from)){terminating.add(e.from);changed=true;}}
  if(terminating.size!==Object.keys(g.nodes).length)throw Error('Every node must have a path to a terminal');
  // Required gates must dominate every successful terminal.
  for(const gate of g.requiredGates ?? []) {
    if(!g.nodes[gate])throw Error('Unknown gate');
    const seen=new Set(); const bypass=id=>{if(id===gate || seen.has(id))return;seen.add(id);if(g.nodes[id].success)throw Error(`Success bypasses gate: ${gate}`);g.edges.filter(e=>e.from===id).forEach(e=>bypass(e.to));};bypass(g.start);
  }
  if(g.evidenceMode==='structured') {
    const contracts=[['worker','completed'],['reviewer','passed'],['validator','passed'],['user','approved']];
    if(g.engineeringQuality)contracts.push(['planner','ready']);
    if(g.criticalPlanning)contracts.push(['supreme-coordinator','ready']);
    if(g.productPreparation)contracts.push(['domain-coordinator','allowed']);
    for(const [role,outcome] of contracts) {
      const matching=Object.entries(g.nodes).filter(([,n])=>n.role===role&&n.outcomes.includes(outcome));
      if(!matching.length)throw Error(`Required evidence contract missing: ${role}.${outcome}`);
      const seen=new Set();
      const walk=id=>{
        if(seen.has(id))return;seen.add(id);
        if(g.nodes[id].success)throw Error(`Success bypasses evidence contract: ${role}.${outcome}`);
        for(const edge of g.edges.filter(e=>e.from===id))if(!(g.nodes[id].role===role&&edge.outcome===outcome))walk(edge.to);
      };
      walk(g.start);
    }
    for(const [id,n] of Object.entries(g.nodes)) {
      if(['worker','reviewer','validator','planner','supreme-coordinator','domain-coordinator'].includes(n.role)&&n.type!=='agent')throw Error(`Evidence role requires agent node: ${id}`);
    }
  }
  return g;
}
