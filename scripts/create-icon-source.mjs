// 可重复生成的矢量式圆角图标：薄荷底色、粗线流程箭头，透明外角。
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
const n = 1024;
const png = new PNG({ width: n, height: n });
const paths = [
  { points: [[280,310],[490,310],[630,450],[745,450]], color: [16,95,97] },
  { points: [[280,520],[410,520],[550,660],[745,660]], color: [25,144,171] }
];
const dist = (x,y,a,b) => { const dx=b[0]-a[0], dy=b[1]-a[1]; const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy))); return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy); };
for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
  const k=(y*n+x)*4;
  const qx=Math.max(Math.abs(x-512)-300,0), qy=Math.max(Math.abs(y-512)-300,0);
  if(Math.hypot(qx,qy)>180) continue;
  let color=[218+Math.round(y/n*10),248,238];
  for(const p of paths) {
    if(p.points.slice(1).some((b,i)=>dist(x,y,p.points[i],b)<44)) color=p.color;
    const tip=p.points.at(-1); // 箭头头部，向右；小尺寸仍保留可辨识的轮廓。
    if(x>=tip[0]-52 && x<=tip[0]+58 && Math.abs(y-tip[1])<=(tip[0]+58-x)*0.87) color=p.color;
  }
  png.data[k]=color[0]; png.data[k+1]=color[1]; png.data[k+2]=color[2]; png.data[k+3]=255;
}
await writeFile('build/icon-source.png',PNG.sync.write(png));
await writeFile('build/icon-source.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="32" y="32" width="960" height="960" rx="180" fill="#dff8ee"/><g fill="none" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"><path d="M280 310H490L630 450H745" stroke="#105f61"/><path d="M280 520H410L550 660H745" stroke="#1990ab"/></g><path d="M693 355L803 450L693 545Z" fill="#105f61"/><path d="M693 565L803 660L693 755Z" fill="#1990ab"/></svg>`);
