// Cold Node scripts import the workspace TypeScript packages, which import
// their JSON schemas without import attributes: Vite and Vitest accept that,
// Node does not. This hook serves such a JSON file as a module whose default
// export is the parsed value. Register it before importing those packages.
import {register} from 'node:module';
const hook=`export async function load(url,context,next){
  if(url.startsWith('file:')&&url.endsWith('.json')&&context.importAttributes?.type!=='json'){
    const loaded=await next(url,{...context,importAttributes:{type:'json'}});
    return {format:'module',shortCircuit:true,source:'export default '+String(loaded.source)+';'};
  }
  return next(url,context);
}`;
register('data:text/javascript,'+encodeURIComponent(hook));
