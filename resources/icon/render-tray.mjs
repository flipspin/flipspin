// Derive the native monochrome template from Flipspin’s existing figure. Run from repo root.
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:36,height:36},deviceScaleFactor:1});
let svg=fs.readFileSync('resources/icon/krobi-figure.svg','utf8');
// White and orange are knockouts in the monochrome template.
svg=svg.replaceAll('#FFFFFF','#FFFFFF').replaceAll('#F29A38','#FFFFFF').replaceAll('#16181F','#000000');
await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:36px;height:36px}</style>${svg}`);
const data=await page.screenshot({omitBackground:true});
// Turn white into transparent; preserve antialiasing through luminance.
const encoded=await page.evaluate(async data=>{const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=c.height=36;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,36,36);for(let i=0;i<d.data.length;i+=4){d.data[i+3]=Math.round(d.data[i+3]*(1-d.data[i]/255));d.data[i]=d.data[i+1]=d.data[i+2]=0;}x.putImageData(d,0,0);return c.toDataURL().split(',')[1]},data.toString('base64'));
fs.writeFileSync('src-tauri/icons/tray-template.png',Buffer.from(encoded,'base64'));
await browser.close();
