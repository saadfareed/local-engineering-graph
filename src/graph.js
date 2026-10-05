export function validateGraph(g) {
  if (!g || typeof g.id !== 'string' || !Number.isInteger(g.version) || g.version < 1 || !g.nodes || !Array.isArray(g.edges)) throw Error('Invalid graph header');
  if (g.evidenceMode !== undefined && g.evidenceMode !== 'structured') throw Error('Invalid evidence mode');
  if (!g.nodes[g.start]) throw Error('Missing start node');
  for (const [id,n] of Object.entries(g.nodes)) {
    if (!['agent','approval','terminal'].includes(n.type)) throw Error(`Invalid node type: ${id}`);
    if (!Array.isArray(n.outcomes) || new Set(n.outcomes).size !== n.outcomes.length) throw Error(`Invalid outcomes: ${id}`);
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
  // Required gates must dominate every successful terminal.
  for(const gate of g.requiredGates ?? []) {
    if(!g.nodes[gate])throw Error('Unknown gate');
    const seen=new Set(); const bypass=id=>{if(id===gate || seen.has(id))return;seen.add(id);if(g.nodes[id].success)throw Error(`Success bypasses gate: ${gate}`);g.edges.filter(e=>e.from===id).forEach(e=>bypass(e.to));};bypass(g.start);
  }
  return g;
}
