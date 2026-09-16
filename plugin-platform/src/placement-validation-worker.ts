import { validatePlacementSemantics } from './placement-semantics';
// Trusted code only; terminate this worker after one bounded validation.
self.onmessage=(event:MessageEvent)=>{
  try {
    if(typeof event.data?.text!=='string'||typeof event.data?.tool!=='string')throw new Error('Invalid validation request');
    validatePlacementSemantics(event.data.text,event.data.tool);
    self.postMessage({ok:true});
  }catch(error){self.postMessage({ok:false,error:error instanceof Error?error.message:'Invalid import'});}
};
