import { validatePlacementSemantics } from './placement-semantics';
import { checkFootprintStructure, sanitizeFootprint, validateFootprintSemantics } from './footprint-semantics';
// Trusted code only; terminate this worker after one bounded validation.
// `{text, tool}` validates a symbol placement blob; `{text, tool, kind:'footprint', name}`
// sanitizes a footprint and answers with the text that may be stored.
self.onmessage=(event:MessageEvent)=>{
  try {
    const data=event.data;
    if(typeof data?.text!=='string'||typeof data?.tool!=='string')throw new Error('Invalid validation request');
    if(data.kind==='footprint'){
      if(typeof data.name!=='string')throw new Error('Invalid validation request');
      checkFootprintStructure(data.text);
      const text=sanitizeFootprint(data.text,data.name);
      validateFootprintSemantics(text);
      self.postMessage({ok:true,text});
      return;
    }
    if(data.kind!==undefined&&data.kind!=='symbol')throw new Error('Invalid validation request');
    validatePlacementSemantics(data.text,data.tool);
    self.postMessage({ok:true});
  }catch(error){self.postMessage({ok:false,error:error instanceof Error?error.message:'Invalid import'});}
};
