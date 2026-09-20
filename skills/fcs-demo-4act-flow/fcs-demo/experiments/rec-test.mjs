import { Recorder, N_FIELDS } from '../src/rec/recorder.js';

let pass=0, fail=0;
const ck=(n,c,x='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${x}`)); };
const row=(t)=>Float64Array.from({length:N_FIELDS},(_,i)=> i===0?t:t);

// 1) 未填满
{ const r=new Recorder({capacity:100,every:1});
  for(let i=0;i<40;i++) r.pushRow(row(i*0.5));
  const ts=[]; for(let i=0;i<r.count;i++) ts.push(r.get(i,0));
  ck('未填满 count=40', r.count===40, `count=${r.count}`);
  ck('未填满 时间单调', ts.every((v,i)=>!i||v>ts[i-1]), JSON.stringify(ts.slice(0,4)));
}

// 2) 绕回 —— 最易出错
{ const r=new Recorder({capacity:100,every:1});
  for(let i=0;i<250;i++) r.pushRow(row(i*0.5));
  const ts=[]; for(let i=0;i<r.count;i++) ts.push(r.get(i,0));
  ck('绕回 count 封顶=100', r.count===100, `count=${r.count}`);
  ck('绕回 dropped=150', r.dropped===150, `dropped=${r.dropped}`);
  ck('绕回 时间仍单调递增', ts.every((v,i)=>!i||v>ts[i-1]), `前4=${JSON.stringify(ts.slice(0,4))} 后4=${JSON.stringify(ts.slice(-4))}`);
  ck('绕回 保留最新(249*0.5=124.5)', ts.at(-1)===124.5, `末=${ts.at(-1)}`);
  ck('绕回 最旧=150*0.5=75', ts[0]===75, `最旧=${ts[0]}`);
  // window 二分在绕回后是否仍正确
  const [a,b]=r.window(90,110);
  const inWin=[]; for(let i=a;i<b;i++) inWin.push(r.get(i,0));
  ck('绕回 window(90,110) 结果全在区间内', inWin.length>0 && inWin.every(t=>t>=90&&t<=110), `[${a},${b}) n=${inWin.length} 首=${inWin[0]} 末=${inWin.at(-1)}`);
  // CSV 顺序
  const lines=r.toCSV().trim().split('\n');
  const v=lines.slice(1).map(l=>Number(l.split(',')[0]));
  ck('绕回 toCSV 共101行', lines.length===101, `行数=${lines.length}`);
  ck('绕回 toCSV 时间列单调', v.every((x,i)=>!i||x>v[i-1]), `首=${v[0]} 末=${v.at(-1)}`);
}

// 3) 空 / 单点
{ const r=new Recorder({capacity:100,every:1});
  const lines=r.toCSV().trim().split('\n');
  ck('空 toCSV 仅表头', lines.length===1, `行数=${lines.length}`);
  ck('空 count=0 span=0', r.count===0&&r.span===0);
  ck('空 get(0,0)=NaN 不抛', Number.isNaN(r.get(0,0)));
  ck('越界 get(-1)/get(999)=NaN', Number.isNaN(r.get(-1,0))&&Number.isNaN(r.get(999,0)));
  const [a,b]=r.window(0,999); ck('空 window 返回 [0,0)', a===0&&b===0, `[${a},${b})`);
  r.pushRow(row(7));
  ck('单点 toCSV=2行', r.toCSV().trim().split('\n').length===2);
}

// 4) clear 后可复用
{ const r=new Recorder({capacity:50,every:1});
  for(let i=0;i<80;i++) r.pushRow(row(i));
  r.clear();
  ck('clear 后 count=0 head=0', r.count===0&&r.head===0);
  for(let i=0;i<30;i++) r.pushRow(row(i*2));
  const ts=[]; for(let i=0;i<r.count;i++) ts.push(r.get(i,0));
  ck('clear 后复用 单调且=30', r.count===30&&ts.every((v,i)=>!i||v>ts[i-1]), `count=${r.count} 首=${ts[0]}`);
}

// 5) NaN 清洗
{ const r=new Recorder({capacity:10,every:1});
  const bad=Float64Array.from({length:N_FIELDS},()=>NaN); bad[0]=5;
  r.pushRow(bad);
  ck('NaN 被写入为 NaN 而非垃圾', Number.isNaN(r.get(0,3)));
}

console.log(`\n结果：PASS=${pass}  FAIL=${fail}`);
process.exit(fail?1:0);
