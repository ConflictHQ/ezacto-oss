/** Keep room below Workers Free's 50 database calls for lease cleanup. A D1
 * batch is one call; statements still obey D1's parameter and SQL byte limits. */
export class CsvInvocationBudget extends Error { constructor(){super('csv_invocation_budget')} }
export const csvInvocationDatabase=(database:D1Database,limit=38,allowSchemaStatements=false)=>{
  let calls=0
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>()
  const take=()=>{if(calls>=limit)throw new CsvInvocationBudget();calls++}
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{const wrapped=new Proxy(statement,{get(target,key){
    if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values))
    if(['run','all','first','raw'].includes(String(key)))return(...args:unknown[])=>{take();const method=Reflect.get(target,key,target) as (...values:unknown[])=>unknown;return method.apply(target,args)}
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }});originals.set(wrapped,statement);return wrapped}
  const value=new Proxy(database,{get(target,key){
    if(key==='prepare')return(sql:string)=>{if(new TextEncoder().encode(sql).length>100000)throw new CsvInvocationBudget();return wrap(target.prepare(sql))}
    if(key==='batch')return(statements:D1PreparedStatement[])=>{take();return target.batch(statements.map(statement=>originals.get(statement)??statement))}
    if(key==='exec'&&allowSchemaStatements)return(sql:string)=>{take();return target.exec(sql)}
    if(key==='exec'||key==='withSession')return()=>{throw new CsvInvocationBudget()}
    const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result
  }})
  return{database:value,calls:()=>calls}
}
