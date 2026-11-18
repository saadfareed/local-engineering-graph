// Minimal, dependency-free JSON Schema subset validator used by the Meta-OS kernel for decision
// cards, HITL delta records, adapter manifests and generative UI layouts. Supports the subset the
// kernel schemas actually use: type, enum, const, required, properties, additionalProperties,
// patternProperties, items, min/max(Items|Length|imum), uniqueItems, pattern, allOf/anyOf/oneOf,
// if/then/else, and local $ref into #/$defs.
// It is a consistency check on local trusted files, not a security boundary.
const TYPE_CHECKS={
  string:v=>typeof v==='string',number:v=>typeof v==='number'&&Number.isFinite(v),integer:v=>Number.isInteger(v),
  boolean:v=>typeof v==='boolean',object:v=>v!==null&&typeof v==='object'&&!Array.isArray(v),array:v=>Array.isArray(v),null:v=>v===null
};
function resolveRef(root,ref){
  if(typeof ref!=='string'||!ref.startsWith('#/'))throw Error(`Unsupported $ref: ${ref}`);
  let node=root;for(const part of ref.slice(2).split('/')){node=node?.[part.replace(/~1/g,'/').replace(/~0/g,'~')];if(node===undefined)throw Error(`Unresolved $ref: ${ref}`);}
  return node;
}
export function validate(schema,value,{root=schema,path='$'}={}){
  const errors=[];
  const push=message=>errors.push(`${path}: ${message}`);
  if(schema===true)return errors;if(schema===false){push('schema forbids any value');return errors;}
  if(schema.$ref)return validate(resolveRef(root,schema.$ref),value,{root,path});
  if(schema.type!==undefined){
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    if(!types.some(t=>TYPE_CHECKS[t]?.(value))){push(`expected ${types.join('|')}`);return errors;}
  }
  if(schema.enum&&!schema.enum.some(e=>JSON.stringify(e)===JSON.stringify(value)))push(`expected one of ${JSON.stringify(schema.enum)}`);
  if(schema.const!==undefined&&JSON.stringify(schema.const)!==JSON.stringify(value))push(`expected const ${JSON.stringify(schema.const)}`);
  if(typeof value==='string'){
    if(schema.minLength!==undefined&&value.length<schema.minLength)push(`shorter than ${schema.minLength}`);
    if(schema.maxLength!==undefined&&value.length>schema.maxLength)push(`longer than ${schema.maxLength}`);
    if(schema.pattern&&!new RegExp(schema.pattern,'u').test(value))push(`does not match ${schema.pattern}`);
  }
  if(typeof value==='number'){
    if(schema.minimum!==undefined&&value<schema.minimum)push(`below minimum ${schema.minimum}`);
    if(schema.maximum!==undefined&&value>schema.maximum)push(`above maximum ${schema.maximum}`);
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems)push(`fewer than ${schema.minItems} items`);
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)push(`more than ${schema.maxItems} items`);
    if(schema.uniqueItems&&new Set(value.map(v=>JSON.stringify(v))).size!==value.length)push('items are not unique');
    if(schema.items)value.forEach((item,i)=>errors.push(...validate(schema.items,item,{root,path:`${path}[${i}]`})));
  }
  if(TYPE_CHECKS.object(value)){
    const present=Object.keys(value).filter(k=>value[k]!==undefined); // JSON has no undefined; treat such keys as absent
    for(const key of schema.required??[])if(!present.includes(key))push(`missing required property "${key}"`);
    for(const [key,sub] of Object.entries(schema.properties??{}))if(key in value)errors.push(...validate(sub,value[key],{root,path:`${path}.${key}`}));
    if(schema.additionalProperties!==undefined&&schema.additionalProperties!==true){
      for(const key of present){
        if(schema.properties&&key in schema.properties)continue;
        if(schema.patternProperties&&Object.keys(schema.patternProperties).some(p=>new RegExp(p,'u').test(key)))continue;
        if(schema.additionalProperties===false)push(`unexpected property "${key}"`);
        else errors.push(...validate(schema.additionalProperties,value[key],{root,path:`${path}.${key}`}));
      }
    }
    for(const [pattern,sub] of Object.entries(schema.patternProperties??{}))for(const key of present)if(new RegExp(pattern,'u').test(key))errors.push(...validate(sub,value[key],{root,path:`${path}.${key}`}));
  }
  if(schema.if){const branch=validate(schema.if,value,{root,path}).length?schema.else:schema.then;if(branch!==undefined)errors.push(...validate(branch,value,{root,path}));}
  if(schema.allOf)for(const sub of schema.allOf)errors.push(...validate(sub,value,{root,path}));
  if(schema.anyOf&&!schema.anyOf.some(sub=>!validate(sub,value,{root,path}).length))push('matches none of anyOf');
  if(schema.oneOf&&schema.oneOf.filter(sub=>!validate(sub,value,{root,path}).length).length!==1)push('does not match exactly one of oneOf');
  return errors;
}
export function assertValid(schema,value,label='value'){
  const errors=validate(schema,value);
  if(errors.length)throw Error(`Invalid ${label}:\n  ${errors.join('\n  ')}`);
  return value;
}
