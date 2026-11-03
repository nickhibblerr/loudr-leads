const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadTypeScript:load}=require('./load-ts.cjs');
const methods=load('lib/payment-methods.ts');
const pricing=load('lib/lead-pricing.ts',{'@/lib/payment-methods':methods});
const topup=load('lib/top-up.ts');
const plans=load('lib/whop-plans.ts',{'@/lib/payment-methods':methods,'@/lib/lead-pricing':pricing,'@/lib/top-up':topup});
const nativePlans=load('lib/lead-checkout.ts',{'@/lib/payment-methods':methods});
const orderLib=load('lib/paid-lead-order.ts',{'@/lib/payment-methods':methods,'@/lib/lead-pricing':pricing,'@/lib/whop-plans':plans,'@/lib/lead-checkout':nativePlans});
function fixture(){
 const quote=pricing.calculateLeadQuote('TX',5,[{code:'TX',name:'Texas',price:400}],'card');
 const plan={id:'plan_order',account:{id:'biz_test'},product:{id:'prod_test'},currency:'usd',plan_type:'one_time',visibility:'quick_link',initial_price:2054,adaptive_pricing_enabled:true,metadata:pricing.leadMetadata(quote),payment_method_configuration:methods.paymentConfigurationFor('card')};
 const payment={id:'pay_test',status:'paid',paid_at:'2026-11-03T12:00:00Z',account_id:'biz_test',product_id:'prod_test',plan_id:plan.id,metadata:{state:'CA',quantity:'999'}};
 return {plan,payment};
}
test('notification trusts historical merchant plan, not current rates or buyer metadata',()=>{
 const {plan,payment}=fixture();const order=orderLib.paidLeadOrder(payment,plan,'biz_test','prod_test');
 assert.equal(order.state,'TX');assert.equal(order.quantity,5);assert.equal(order.orderTotalUsd,2054);
 const text=orderLib.slackOrderMessage(order).text;assert.match(text,/Texas \(TX\)/);assert.match(text,/Leads: 5/);assert.match(text,/pay_test/);assert(!text.includes('999'));
});
test('reject pending transfers, wrong merchant/product, and inconsistent plans',()=>{
 const {plan,payment}=fixture();
 for(const change of [{status:'pending'},{paid_at:null},{account_id:'biz_other'},{product_id:'prod_other'},{plan_id:'plan_other'}])assert.throws(()=>orderLib.paidLeadOrder({...payment,...change},plan,'biz_test','prod_test'));
 for(const change of [{initial_price:1},{metadata:{...plan.metadata,quantity:'6'}},{metadata:{...plan.metadata,source:'other'}},{payment_method_configuration:methods.paymentConfigurationFor('bank')}])assert.throws(()=>orderLib.paidLeadOrder(payment,{...plan,...change},'biz_test','prod_test'));
});
function deliveryFixture(){
 let stored=null,etag=0,posts=0,failSlack=false,failStore=false;
 const blob={get:async()=>{if(failStore)throw Error('offline');return stored?{statusCode:200,blob:{size:100,etag:String(etag)},stream:JSON.stringify(stored)}:null;},put:async(path,data,options)=>{if(options.ifMatch!==undefined&&options.ifMatch!==String(etag))throw Error('conflict');if(stored&&!options.allowOverwrite)throw Error('exists');stored=JSON.parse(data);return {etag:String(++etag)};}};
 const env={BLOB_READ_WRITE_TOKEN:'test',SLACK_LEAD_ORDERS_WEBHOOK_URL:'https://hooks.slack.com/services/test/channel/secret'};
 const mod=load('lib/slack-order-delivery.ts',{'@vercel/blob':blob},{process:{env},AbortSignal,fetch:async()=>{posts++;return new Response(failSlack?'error':'ok',{status:failSlack?500:200});}});
 return {mod,env,posts:()=>posts,setFailSlack:()=>{failSlack=true},setFailStore:()=>{failStore=true},expire:()=>{stored.updatedAt=0;}};
}
test('successful delivery persists receipt and suppresses replay',async()=>{
 const f=deliveryFixture();assert.equal(await f.mod.deliverSlackOrder('pay_test',{text:'order'}),'sent');assert.equal(await f.mod.deliverSlackOrder('pay_test',{text:'order'}),'duplicate');assert.equal(f.posts(),1);
});
test('concurrent deliveries acquire a single claim',async()=>{
 const f=deliveryFixture();const outcomes=await Promise.allSettled([f.mod.deliverSlackOrder('pay_test',{text:'order'}),f.mod.deliverSlackOrder('pay_test',{text:'order'})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.posts(),1);
});
test('Slack failure and active lease fail, expired lease permits retry',async()=>{
 const f=deliveryFixture();f.setFailSlack();await assert.rejects(f.mod.deliverSlackOrder('pay_test',{text:'order'}));await assert.rejects(f.mod.deliverSlackOrder('pay_test',{text:'order'}));assert.equal(f.posts(),1);f.expire();await assert.rejects(f.mod.deliverSlackOrder('pay_test',{text:'order'}));assert.equal(f.posts(),2);
});
test('storage failure and foreign webhook URLs never post',async()=>{
 const f=deliveryFixture();f.setFailStore();await assert.rejects(f.mod.deliverSlackOrder('pay_test',{text:'order'}));assert.equal(f.posts(),0);
 const g=deliveryFixture();g.env.SLACK_LEAD_ORDERS_WEBHOOK_URL='https://example.com/services/test';await assert.rejects(g.mod.deliverSlackOrder('pay_test',{text:'order'}));assert.equal(g.posts(),0);
});
test('webhook requires signature and succeeded event; delivery errors are retryable',async()=>{
 const {payment,plan}=fixture();let signed=true,type='payment.succeeded',failure=false,delivered=0;
 const route=load('app/api/webhooks/whop/route.ts',{'@whop/sdk':{WhopClient:class{payments={retrieve:async()=>payment};plans={retrieve:async()=>plan};}},'@whop/sdk/helpers':{unwrapWebhook:()=>{if(!signed)throw Error('signature');return {type,data:{id:payment.id}};}},'@/lib/paid-lead-order':orderLib,'@/lib/paid-order-store':{recordPaidOrder:async()=>{}},'@/lib/slack-order-delivery':{deliverSlackOrder:async()=>{if(failure)throw Error('offline');delivered++;return 'sent';}}},{process:{env:{WHOP_WEBHOOK_SECRET:'test',WHOP_ACCOUNT_ID:'biz_test',WHOP_LEADS_PRODUCT_ID:'prod_test',WHOP_API_KEY:'test',SLACK_LEAD_ORDERS_WEBHOOK_URL:'configured'}},console:{error:()=>{}}});
 const req=()=>new Request('https://example.com/api/webhooks/whop',{method:'POST',body:'{}'});
 signed=false;assert.equal((await route.POST(req())).status,400);assert.equal(delivered,0);
 signed=true;type='payment.pending';assert.equal((await route.POST(req())).status,200);assert.equal(delivered,0);
 type='payment.succeeded';failure=true;assert.equal((await route.POST(req())).status,503);assert.equal(delivered,0);
 failure=false;assert.equal((await route.POST(req())).status,200);assert.equal(delivered,1);
 payment.account_id='biz_other';assert.equal((await route.POST(req())).status,200);assert.equal(delivered,1);
});
