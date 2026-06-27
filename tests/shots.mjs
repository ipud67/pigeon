import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://localhost:3212';
const facts=JSON.parse(readFileSync('./data/facts.json','utf8'));
const wid=(facts.find(r=>r.weigh_it_questions.length)||facts[0]).id;
const b=await chromium.launch();
// home (dark, desktop-ish narrow)
let c=await b.newContext({viewport:{width:520,height:1100},deviceScaleFactor:2});
let p=await c.newPage();
await p.goto(BASE+'/',{waitUntil:'networkidle'});
await p.screenshot({path:'docs/screens/home-dark.png',fullPage:true});
// detail with weigh-it
await p.goto(BASE+'/story/'+wid,{waitUntil:'networkidle'});
await p.screenshot({path:'docs/screens/detail-weighit-dark.png',fullPage:true});
// predict
await p.goto(BASE+'/predict',{waitUntil:'networkidle'});
await p.screenshot({path:'docs/screens/predict-dark.png',fullPage:true});
// weekly
await p.goto(BASE+'/weekly',{waitUntil:'networkidle'});
await p.screenshot({path:'docs/screens/weekly-dark.png',fullPage:true});
await c.close();
// mobile light home
c=await b.newContext({...devices['iPhone 13']});
p=await c.newPage();
await p.goto(BASE+'/',{waitUntil:'networkidle'});
await p.waitForTimeout(500);
await p.locator('.toggle-btn').click(); await p.waitForTimeout(200);
await p.screenshot({path:'docs/screens/home-mobile-light.png',fullPage:true});
await c.close();
await b.close();
console.log('screens written: weigh-it story id',wid);
