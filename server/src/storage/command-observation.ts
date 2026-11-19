import type { StorageCommandEnvelope } from './contracts.js';

export interface ObservedCommandResult {state:string;value?:unknown;operationId?:string;committedAt?:number;replayed?:boolean;code?:string}
type Observer=(request:StorageCommandEnvelope,result:ObservedCommandResult)=>void;
const observers=new WeakMap<object,Observer>();
export function observeStorageCommands(port:object,observer:Observer){
  if(observers.has(port))throw new Error('COMMAND_OBSERVER_ALREADY_REGISTERED');
  observers.set(port,observer);
  return()=>{if(observers.get(port)===observer)observers.delete(port);};
}
/** Observes confirmed receipts only. Observer failures never alter a business result. */
export function publishCommandObservation(port:object,request:StorageCommandEnvelope,result:ObservedCommandResult){
  try{observers.get(port)?.(request,result);}catch{/* Best effort analytics; no retry or transaction dependency. */}
}
