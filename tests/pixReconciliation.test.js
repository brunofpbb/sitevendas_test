'use strict';
const assert=require('node:assert/strict');
const make=require('../reconciliation/pixReconciliation');
const HEADER=['Data/horaSolicitação','Valor','Status','StatusPagamento','Referencia','idPagamento','NumPassagem','Data_Viagem','Hora_Partida','IdViagem','IdOrigem','IdDestino','poltrona'];
const refGroup='dc84ca05-b4c6-4387-b7b4-9012288d04fc';
const refId='11e0a4fd-559e-4e47-a7bc-f78d9f3fbea5';
const row=(ref,value,way,id='')=>[
 '06/11/2026 21:26:58',value,'Aguardando pagamento','Pendente',ref,id,'',
 way==='ida'?'2026-11-20':'2026-11-22',way==='ida'?'09:00':'15:27',
 way==='ida'?'51011':'51152',way==='ida'?'24':'14',way==='ida'?'14':'24','3'
];
async function test(reference,expectedPayment,rows,expectedApproved) {
 const called=[], issued=[];
 const service=make({
   sheets:async()=>({spreadsheets:{values:{get:async()=>({data:{values:[HEADER,...rows]}})}}}),
   spreadsheetId:'fixture',sheetTab:'BPE',accessToken:'fake',fetch:async(url)=>{
     called.push(url);
     const obj=url.includes('/search?')?{results:[expectedPayment],paging:{total:1}}:expectedPayment;
     return {ok:true,text:async()=>JSON.stringify(obj)};
   },
   onApproved:async record=>{called.push('approved:'+record.reference)},
   processPayment:async payment=>{issued.push(payment.id)},
   autoIssue:false
 });
 const actual=await service.scan({onlyReference:reference});
 assert.equal(actual.checked,1);
 assert.equal(actual.approved,expectedApproved?1:0);
 assert.equal(actual.manual,expectedApproved?1:0);
 assert.equal(issued.length,0,'não pode emitir automaticamente');
 assert.equal(called.some(c=>c==='approved:'+reference),expectedApproved);
 return actual;
}
(async()=>{
 await test(refGroup,{id:123,external_reference:refGroup,payment_method_id:'pix',status:'approved',transaction_amount:268.82},
   [row(refGroup,'133.00','ida'),row(refGroup,'135.82','volta')],true);
 await test(refId,{id:187184092449,external_reference:refId,payment_method_id:'pix',status:'approved',transaction_amount:65.6},
   [row(refId,'65.60','ida','187184092449')],true);
 await test(refGroup,{id:123,external_reference:refGroup,payment_method_id:'pix',status:'approved',transaction_amount:99},
   [row(refGroup,'133.00','ida'),row(refGroup,'135.82','volta')],false);
 console.log('PIX reconciliation: 3 cenários aprovados');
})().catch(error=>{console.error(error);process.exitCode=1});
