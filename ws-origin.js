const W=require('./app/node_modules/ws');
const w=new W('ws://localhost:8080/ws?token='+process.argv[2],{origin:process.argv[3]});
w.on('unexpected-response',(q,r)=>{console.log('REJECTED, HTTP',r.statusCode);process.exit()});
w.on('open',()=>{console.log('CONNECTED');process.exit()});
w.on('error',e=>{console.log('error',e.message);process.exit()});
setTimeout(()=>process.exit(),5000);
