const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadTypeScript:load}=require('./load-ts.cjs');
const methods=load('lib/payment-methods.ts');
const pricing=load('lib/lead-pricing.ts',{'@/lib/payment-methods':methods});
const cartLib=load('lib/lead-cart.ts',{'@/lib/lead-pricing':pricing,'@/lib/payment-methods':methods});
const native = load('lib/lead-checkout.ts', { '@/lib/payment-methods': methods, '@/lib/lead-cart': cartLib });
const legacy=load('lib/whop-plans.ts',{'@/lib/payment-methods':methods,'@/lib/lead-pricing':pricing,'@/lib/top-up':load('lib/top-up.ts')});
const orders=load('lib/paid-lead-order.ts',{'@/lib/lead-cart':cartLib,'@/lib/payment-methods':methods,'@/lib/lead-pricing':pricing,'@/lib/lead-checkout':native,'@/lib/whop-plans':legacy});
function harness(){
 const plans=[];const creates=[];
 return {plans,creates,client:{plans:{list:async()=>plans,create:async(input,options)=>{const plan={...input,...options.additionalBodyParameters,id:`plan_${plans.length+1}`,account:{id:'biz_test'},product:{id:'prod_test'}};plans.push(plan);creates.push(options);return plan;}}}};
}
async function fixture(mode='card',state='AL',quantity=5){
 const h=harness(),quote=pricing.calculateLeadQuote(state,quantity,undefined,mode);
 const checkout=await native.getLeadCheckout(h.client,'biz_test','prod_test',quote);
 const payment={id:'pay_test',status:'paid',paid_at:'2026-11-03T12:00:00Z',account_id:'biz_test',product_id:null,plan_id:null,currency:'usd',metadata:{state:'CA',quantity:'999'},
 line_items:checkout.items.map(item=>{const p=h.plans.find(p=>p.id===item.plan);return {plan_id:p.id,product_id:'prod_test',quantity:item.quantity,subtotal:{amount:(p.initial_price*item.quantity).toFixed(2),currency:'usd'}};})};
 return {...h,quote,checkout,payment};
}
test('native unit plans reuse across quantities; fees round once on the whole subtotal',async()=>{
 const h=harness();const one=pricing.calculateLeadQuote('AL',1,undefined,'card'),five=pricing.calculateLeadQuote('AL',5,undefined,'card');
 const a=await native.getLeadCheckout(h.client,'biz_test','prod_test',one),b=await native.getLeadCheckout(h.client,'biz_test','prod_test',five);
 assert.equal(a.planId,b.planId);assert.notEqual(a.feePlanId,b.feePlanId);
 assert.equal(h.plans[0].initial_price,325);assert.equal(h.plans[0].allow_multiple_quantity,true);
 assert.equal(h.plans[0].metadata.quantity,undefined);assert.equal(h.plans[0].sku,'LOUDR-LEADS-AL');
 assert.equal(b.items[0].quantity,5);assert.equal(b.items[1].quantity,1);
 assert.equal(h.plans.find(p=>p.id===b.feePlanId).initial_price,48.75);
 assert.equal(five.total,1673.75);
});
test('paid receipts determine actual lead quantity and ignore buyer metadata and card fee quantity',async()=>{
 const f=await fixture();const o=orders.paidLeadOrder(f.payment,f.plans,'biz_test','prod_test');
 assert.equal(o.quantity,5);assert.equal(o.items[0].state,'AL');assert.equal(o.orderTotalUsd,1673.75);
 assert.match(orders.slackOrderMessage(o).text,/Leads: 5/);
 const bank=await fixture('bank');assert.equal(bank.checkout.items.length,1);assert.equal(orders.paidLeadOrder(bank.payment,bank.plans,'biz_test','prod_test').quantity,5);
});
test('receipt validation rejects altered/missing items, quantities, amounts, state and merchant',async()=>{
 const f=await fixture();const clone=()=>JSON.parse(JSON.stringify(f.payment));
 for(const mutate of [p=>p.status='pending',p=>p.account_id='biz_wrong',p=>p.line_items[0].quantity=6,p=>p.line_items[0].quantity=1.5,p=>p.line_items[0].quantity=1001,p=>p.line_items[1].quantity=2,p=>p.line_items.pop(),p=>p.line_items[0].subtotal.amount='0.01',p=>p.line_items[0].product_id='prod_wrong',p=>p.line_items.push(p.line_items[0])]){
  const p=clone();mutate(p);assert.throws(()=>orders.paidLeadOrder(p,f.plans,'biz_test','prod_test'));
 }
 const plans=JSON.parse(JSON.stringify(f.plans));plans[0].metadata.state='TX';assert.throws(()=>orders.paidLeadOrder(f.payment,plans,'biz_test','prod_test'));
});
test('adaptive receipt currency is accepted only for adaptive card plans',async()=>{
 const f=await fixture();f.payment.currency='eur';for(const line of f.payment.line_items){line.subtotal.currency='eur';line.subtotal.amount='10.00';}
 assert.equal(orders.paidLeadOrder(f.payment,f.plans,'biz_test','prod_test').quantity,5);
 f.payment.currency='gbp';assert.throws(()=>orders.paidLeadOrder(f.payment,f.plans,'biz_test','prod_test'));
});
test('plan verification refuses legacy bundles and unit plans that do not enable quantities',async()=>{
 const f=await fixture();for(const change of [{allow_multiple_quantity:false},{initial_price:1625},{metadata:{...f.plans[0].metadata,pricing_model:undefined}},{payment_method_configuration:methods.paymentConfigurationFor('bank')}])assert.equal(native.isLeadItemPlan({...f.plans[0],...change},'biz_test','prod_test',f.quote),false);
});
test('paid order snapshots survive retries and fail closed on inconsistent storage',async()=>{
 let content,fail=false;const blob={put:async(_,data)=>{if(fail||content)throw Error('write failed');content=data;},get:async()=>content?{statusCode:200,blob:{size:content.length},stream:content}:null};
 const store=load('lib/paid-order-store.ts',{'@vercel/blob':blob},{process:{env:{BLOB_READ_WRITE_TOKEN:'test'}},AbortSignal});
 const order={paymentId:'pay_test',state:'TX',stateName:'Texas',quantity:5,orderTotalUsd:2500,paymentMode:'bank'};
 await store.recordPaidOrder(order);await store.recordPaidOrder(order);assert.equal(JSON.parse(content).quantity,5);
 await assert.rejects(store.recordPaidOrder({...order,quantity:6}));content=null;fail=true;await assert.rejects(store.recordPaidOrder(order));
});
test('webhook records native cart orders before Slack, and retains them when Slack is not configured',async()=>{
 const f=await fixture();let stored=0,delivered=0,failStore=false;const env={WHOP_WEBHOOK_SECRET:'test',WHOP_ACCOUNT_ID:'biz_test',WHOP_LEADS_PRODUCT_ID:'prod_test',WHOP_API_KEY:'test'};
 const route=load('app/api/webhooks/whop/route.ts',{'@whop/sdk':{WhopClient:class{payments={retrieve:async()=>f.payment};plans={retrieve:async({id})=>f.plans.find(p=>p.id===id)};}},'@whop/sdk/helpers':{unwrapWebhook:()=>({type:'payment.succeeded',data:{id:f.payment.id}})},'@/lib/paid-lead-order':orders,'@/lib/paid-order-store':{recordPaidOrder:async order=>{if(failStore)throw Error('offline');assert.equal(order.quantity,5);stored++;}},'@/lib/slack-order-delivery':{deliverSlackOrder:async()=>{assert(stored);delivered++;return 'sent';}}},{process:{env},console:{error:()=>{}}});
 const req=()=>new Request('https://example.com/api/webhooks/whop',{method:'POST',body:'{}'});
 assert.equal((await (await route.POST(req())).json()).delivery,'not_configured');assert.equal(stored,1);assert.equal(delivered,0);
 env.SLACK_LEAD_ORDERS_WEBHOOK_URL='configured';assert.equal((await route.POST(req())).status,200);assert.equal(delivered,1);
 failStore=true;assert.equal((await route.POST(req())).status,503);assert.equal(delivered,1);
});

test('admin price sync reprices existing state lead plans in place and leaves others alone',async()=>{
 const h=harness();const updates=[];h.client.plans.update=async({id,...changes})=>{updates.push(id);const p=h.plans.find(p=>p.id===id);Object.assign(p,changes);return p;};
 await native.getLeadCheckout(h.client,'biz_test','prod_test',pricing.calculateLeadQuote('AL',5,undefined,'card'));
 await native.getLeadCheckout(h.client,'biz_test','prod_test',pricing.calculateLeadQuote('AL',2,undefined,'bank'));
 await native.getLeadCheckout(h.client,'biz_test','prod_test',pricing.calculateLeadQuote('TX',2,undefined,'bank'));
 const fee=h.plans.find(p=>p.metadata.item_role==='card_fee');const feePrice=fee.initial_price;
 const states=pricing.LEAD_STATES.map(s=>s.code==='AL'?{...s,price:410}:s.code==='TX'?{...s,price:null}:s);
 assert.equal(await native.syncLeadPlanPrices(h.client,'biz_test','prod_test',states),2);
 const al=h.plans.filter(p=>p.metadata.state==='AL'&&p.metadata.item_role==='leads');
 assert.equal(al.length,2);for(const p of al){assert.equal(p.initial_price,410);assert.equal(p.metadata.price_per_lead,'410');}
 assert.equal(h.plans.find(p=>p.metadata.state==='TX').initial_price,500,'sold-out states keep their plan untouched');
 assert.equal(fee.initial_price,feePrice,'per-order card fee items are never repriced');
 assert.equal(await native.syncLeadPlanPrices(h.client,'biz_test','prod_test',states),0,'already-synced plans are not updated again');
 const before=h.plans.length;const next=await native.getLeadCheckout(h.client,'biz_test','prod_test',pricing.calculateLeadQuote('AL',3,states,'bank'));
 assert.equal(h.plans.length,before,'checkout reuses the repriced plan');assert.equal(next.planId,al.find(p=>p.metadata.payment_mode==='bank').id);
});
test('orders paid before a price change still verify after the plan is repriced',async()=>{
 for(const mode of ['bank','card']){
  const f=await fixture(mode);const lead=f.plans.find(p=>p.metadata.item_role==='leads');
  lead.initial_price=999;lead.metadata={...lead.metadata,price_per_lead:'999'};
  const o=orders.paidLeadOrder(f.payment,f.plans,'biz_test','prod_test');
  assert.equal(o.quantity,5);assert.equal(o.orderTotalUsd,f.quote.total);
 }
 const f=await fixture('card');f.payment.currency='eur';for(const line of f.payment.line_items){line.subtotal.currency='eur';line.subtotal.amount='10.00';}
 const lead=f.plans.find(p=>p.metadata.item_role==='leads');lead.initial_price=999;lead.metadata={...lead.metadata,price_per_lead:'999'};
 f.payment.usd_total={currency:'usd',amount:String(f.quote.total)};
 assert.equal(orders.paidLeadOrder(f.payment,f.plans,'biz_test','prod_test').orderTotalUsd,f.quote.total,'local-currency card orders report the USD value Whop recorded');
});
