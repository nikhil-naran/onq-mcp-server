import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 850, height: 760 } });
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(resolve('src/mcp/ui/agenda.html')).href);
  const fixture={timezone:'America/Toronto',retrievedAt:'2026-09-08T14:00:00Z',warnings:['Sample course: quiz information unavailable.'],entries:[
    {courseId:1,course:'Sample · Computer science',title:'Problem set 2',kind:'assignment_due',at:'2026-09-10T21:00:00Z',url:'https://onq.queensu.ca/d2l/home/1'},
    {courseId:2,course:'Sample · Engineering',title:'Lab preparation quiz',kind:'quiz_closes',at:'2026-09-11T03:59:00Z',url:'https://onq.queensu.ca/d2l/home/2'},
    {courseId:1,course:'Sample · Computer science',title:'Tutorial',kind:'calendar_event',at:'2026-09-11T16:00:00Z',url:'https://onq.queensu.ca/d2l/home/1'}]};
  await page.evaluate(data=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:data}},'*'),fixture);
  await page.waitForFunction(()=>document.querySelectorAll('#entries li').length===3);
  assert.equal(await page.locator('#warnings').isVisible(),true);
  await mkdir('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/agenda-desktop.png',fullPage:true});
  await page.selectOption('#course','1');assert.equal(await page.locator('#entries li').count(),2);
  await page.selectOption('#kind','quiz_closes');assert.equal(await page.locator('#empty').isVisible(),true);
  await page.selectOption('#course','all');await page.selectOption('#kind','all');
  await page.setViewportSize({width:390,height:780});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'artifacts/agenda-mobile.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});
  await page.screenshot({path:'artifacts/agenda-dark.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Agenda: data delivery, course/type filtering, warnings, empty state, mobile width and console checks passed. Screenshots use labeled sample data.');
} finally {await browser.close();}
