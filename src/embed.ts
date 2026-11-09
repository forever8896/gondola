// Injected into embedded pages (?embed=1). Commands from the app origin: {rd:'play', speed: px/s} | {rd:'pause'} |
// {rd:'by', dy}. Plays top → bottom, holds 1.5 s at the footer, glides back to the top in 900 ms, repeats.
// appOrigin null: the app is on the same origin as the page (static share pages).
export const embedJs = (appOrigin: string | null) => `(()=>{const A=${appOrigin ? JSON.stringify(appOrigin) : 'location.origin'};const se=document.scrollingElement||document.documentElement;
const st=document.createElement('style');st.textContent='html{scroll-behavior:auto!important;scrollbar-width:none}::-webkit-scrollbar{display:none}';document.head.appendChild(st);
let play=false,speed=36,y=0,hold=0,back=null,last=0;const max=()=>Math.max(0,se.scrollHeight-innerHeight);
const ease=t=>1-Math.pow(1-t,3);
function f(t){requestAnimationFrame(f);const dt=last?Math.min(t-last,100):0;last=t;
 if(back){const k=Math.min(1,(t-back.t0)/900);y=back.from*(1-ease(k));se.scrollTop=y;if(k>=1)back=null;return}
 if(!play)return;const m=max();if(m<=0)return;
 if(hold>0){hold-=dt;if(hold<=0)back={t0:t,from:y};return}
 y=Math.min(m,y+speed*dt/1000);se.scrollTop=y;if(y>=m)hold=1500}
requestAnimationFrame(f);
addEventListener('message',e=>{if(e.origin!==A||!e.data||typeof e.data.rd!=='string')return;const d=e.data;
 if(d.rd==='play'){play=true;if(d.speed>0)speed=Math.min(400,d.speed);y=se.scrollTop}
 else if(d.rd==='pause'){play=false}
 else if(d.rd==='by'&&isFinite(d.dy)){back=null;hold=0;y=Math.max(0,Math.min(max(),se.scrollTop+Number(d.dy)));se.scrollTop=y}
 else if(d.rd==='top'){back=null;hold=0;y=0;se.scrollTop=0}});
parent.postMessage({rd:'ready'},A)})();`;
