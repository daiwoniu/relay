export class HostingError extends Error {
  constructor(message:string,readonly status:400|404|409|413|503=400){super(message);}
}
