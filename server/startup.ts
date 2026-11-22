import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export async function openStartupServer(port:number,host:string,origins:readonly string[],api:ReadonlyMap<string,(request:IncomingMessage,response:ServerResponse)=>Promise<void>>) {
  const allowed=new Set(origins);
  const handler=async(request:IncomingMessage,response:ServerResponse)=>{
    const path=request.url?.split('?')[0];
    response.setHeader('Cache-Control','no-store');
    if(request.method==='GET'&&path==='/healthz'){
      response.writeHead(200).end('starting');return;
    }
    const origin=request.headers.origin;
    if(origin&&!allowed.has(origin)){response.writeHead(403).end();return;}
    if(origin)response.setHeader('Access-Control-Allow-Origin',origin);
    response.setHeader('Vary','Origin');
    if(request.method==='OPTIONS'){
      response.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type'}).end();return;
    }
    const handle=api.get(path??'');
    if(handle){
      try {await handle(request,response);}catch{if(!response.headersSent)response.writeHead(503);response.end();}
      return;
    }
    response.writeHead(503,{'Content-Type':'application/json','Retry-After':'3'})
      .end(JSON.stringify({error:'Комната ещё загружается.'}));
  };
  const server=createServer(handler);
  const upgrade=(_request:IncomingMessage,socket:import('node:stream').Duplex)=>{
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 3\r\nContent-Length: 0\r\n\r\n');
  };
  server.on('upgrade',upgrade);
  server.listen(port,host);
  await once(server,'listening');
  return {server,handoff(){server.off('request',handler);server.off('upgrade',upgrade);}};
}
