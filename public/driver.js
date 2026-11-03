"use strict";
const $=s=>document.querySelector(s), esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let password=sessionStorage.getItem("ss_driver")||"",token=localStorage.getItem("ss_driver_token")||"",timer,knownOrders=new Set(),firstLoad=true;
const STATUS_LABELS={
  received:"New delivery order",
  preparing:"Being prepared in the kitchen",
  ready:"Ready for dispatch",
  out_for_delivery:"Awaiting driver pickup",
  picked_up:"Out for delivery"
};
async function api(url,options={}){const r=await fetch(url,{...options,cache:"no-store",headers:{"Content-Type":"application/json","x-driver-password":password,"Authorization":token?"Bearer "+token:"",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.error||"Request failed"),{auth:r.status===401});return d}
function login(msg){clearTimeout(timer);$("#login").hidden=false;$("#board").hidden=true;$("#logout").hidden=true;$("#loginError").hidden=!msg;$("#loginError").textContent=msg||""}
function board(){ $("#login").hidden=true;$("#board").hidden=false;$("#logout").hidden=false}
function render(orders){
  if(!orders.length){$("#orders").innerHTML='<div class="dempty">No active delivery orders right now. New orders will appear here automatically.</div>';return}
  $("#orders").innerHTML=orders.map(o=>{
    const waitingPickup=o.status==="out_for_delivery";
    const onRoad=o.status==="picked_up";
    const canHandover=waitingPickup||onRoad;
    const needsDecision=!o.acceptedByMe&&!waitingPickup&&!onRoad;
    const handover=waitingPickup
      ? '<form class="handover" data-action="pickup"><label>Manager pickup code</label><div class="dcode"><input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code" required><button class="btn primary">Confirm pickup</button></div></form>'
      : onRoad
        ? '<form class="handover" data-action="delivered"><label>Ask the customer for their delivery code</label><div class="dcode"><input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Customer enters 6-digit code" required><button class="btn primary">Confirm delivered</button></div></form>'
        : '<p class="dmuted">This order is visible to you. The kitchen will enable pickup confirmation when it is dispatched.</p>';
    return `<article class="dcard" data-id="${esc(o.id)}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h2>${esc(o.id)}</h2><span class="dstatus">${esc(STATUS_LABELS[o.status]||o.status)}</span></div>
      <p class="dmeta"><strong>${esc(o.customer.name)}</strong><br>📍 ${esc(o.customer.address)}<br>☎ ${esc(o.customer.phone||"")}</p>
      <div class="dmeta">${o.items.map(i=>`${i.qty} × ${esc(i.name)}`).join("<br>")}</div>
      <p><strong>Total: €${Number(o.total).toFixed(2)}</strong></p>
      ${handover}
      ${needsDecision ? `<div class="dcode"><button type="button" class="btn primary" data-decision="accept">Accept order</button><button type="button" class="btn" data-decision="reject">Reject</button></div>` : ""}
    </article>`;
  }).join("")
}
async function load(){
  clearTimeout(timer);
  try{
    const d=await api("/api/driver/orders");
    board();$("#error").hidden=true;
    const fresh=d.orders.filter(o=>!knownOrders.has(o.id));
    if(!firstLoad&&"Notification" in window&&Notification.permission==="granted")fresh.forEach(o=>new Notification("New delivery order",{body:"Order "+o.id+" is now visible in your delivery list."}));
    knownOrders=new Set(d.orders.map(o=>o.id));firstLoad=false;render(d.orders);
  }catch(e){
    if(e.auth){sessionStorage.removeItem("ss_driver");password="";login(e.message);return}
    $("#error").textContent=e.message;$("#error").hidden=false;
  }
  timer=setTimeout(load,5000);
}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const email=$("#email")?$("#email").value.trim():"";password=$("#password").value;if(email){try{const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});const d=await r.json();if(!r.ok)throw new Error((d.error||"Login failed.")+(d.verificationRequired?" Open the main account page (/profile.html) to enter your email code.":""));if(d.user.role!=="driver")throw new Error("This account is not a driver account.");token=d.token;localStorage.setItem("ss_driver_token",token);password="";}catch(ex){login(ex.message);return}}else{sessionStorage.setItem("ss_driver",password)}if("Notification" in window&&Notification.permission==="default")Notification.requestPermission();load()});
$("#logout").addEventListener("click",()=>{sessionStorage.removeItem("ss_driver");localStorage.removeItem("ss_driver_token");token="";password="";$("#password").value="";if($("#email"))$("#email").value="";login()});
$("#orders").addEventListener("click",async e=>{const b=e.target.closest("[data-decision]");if(!b)return;const card=b.closest("[data-id]");b.disabled=true;try{await api("/api/driver/orders/"+encodeURIComponent(card.dataset.id)+"/decision",{method:"POST",body:JSON.stringify({decision:b.dataset.decision})});await load()}catch(ex){alert(ex.message);b.disabled=false}});
$("#orders").addEventListener("submit",async e=>{
  const form=e.target.closest(".handover");if(!form)return;e.preventDefault();
  const card=form.closest("[data-id]"),btn=form.querySelector("button");btn.disabled=true;
  try{await api("/api/driver/orders/"+encodeURIComponent(card.dataset.id)+"/handover",{method:"POST",body:JSON.stringify({action:form.dataset.action,otp:form.elements.otp.value})});await load()}
  catch(ex){alert(ex.message);btn.disabled=false}
});
if(token||password)load();else login();
