"use strict";
const $=s=>document.querySelector(s);
let mode="login";
function showMessage(text){$("#message").textContent=text;$("#message").hidden=false;}
function token(){return localStorage.getItem("ss_auth_token")||"";}
function setMode(next){
 mode=next;
 document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
 $("#nameField").hidden=mode!=="register";$("#phoneField").hidden=mode!=="register";$("#roleField").hidden=mode!=="register";
 $("#passwordHint").textContent=mode==="register"?"Choose a password of at least 10 characters.":"Sign in with your email or staff ID. For the administrator account, enter admin as the email.";
 $("#submitButton").textContent=mode==="register"?"Create account":"Log in";$("#message").hidden=true;
}
function saveSession(d){
 const role=d.user.role;
 ["ss_auth_token","ss_chef_token","ss_driver_token","ss_admin_token"].forEach(k=>localStorage.removeItem(k));
 const key=role==="chef"?"ss_chef_token":role==="driver"?"ss_driver_token":"ss_auth_token";
 localStorage.setItem(key,d.token);localStorage.setItem("ss_customer_profile",JSON.stringify(d.user));
 location.href=role==="chef"?"/staff.html":role==="driver"?"/driver.html":"/menu.html";
}
document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
$("#accountForm").addEventListener("submit",async e=>{
 e.preventDefault();const f=e.currentTarget.elements;const body={email:f.email.value.trim(),password:f.password.value};
 if(mode==="login"&&body.email.toLowerCase()==="admin"){
  try{
   const r=await fetch("/api/auth/admin-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:body.password})});
   const d=await r.json();if(!r.ok)throw new Error(d.error||"Admin login failed.");
   ["ss_auth_token","ss_chef_token","ss_driver_token","ss_admin_token"].forEach(k=>localStorage.removeItem(k));
   localStorage.setItem("ss_admin_token",d.token);location.href="/admin-users.html";
  }catch(err){showMessage(err.message);}return;
 }
 if(mode==="register"){body.name=f.name.value.trim();body.phone=f.phone.value.trim();body.address=f.address.value.trim();body.role=f.role.value;}
 const btn=$("#submitButton");btn.disabled=true;
 try{
  const r=await fetch("/api/auth/"+(mode==="register"?"register":"login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();if(!r.ok)throw new Error(d.error||d.message||"Could not continue.");
  if(d.token){saveSession(d);return;}
  showMessage(d.message||"Account created. Please log in.");
  if(mode==="register"){setMode("login");f.email.value=body.email;f.password.value="";}
 }catch(err){showMessage(err.message);}finally{btn.disabled=false;}
});
$("#logoutButton").addEventListener("click",async()=>{
 try{await fetch("/api/auth/logout",{method:"POST",headers:{Authorization:"Bearer "+token()}});}catch(_){}
 ["ss_auth_token","ss_admin_token","ss_chef_token","ss_driver_token","ss_customer_profile"].forEach(k=>localStorage.removeItem(k));
 location.href="/profile.html";
});
if(token()){
 fetch("/api/auth/me",{headers:{Authorization:"Bearer "+token()}})
 .then(r=>r.ok?r.json():Promise.reject()).then(d=>{
   $("#profileSummary").hidden=false;$("#profileSummary").textContent=d.user.name+" · "+d.user.email;$("#logoutButton").hidden=false;
   if(d.user.role==="customer"){
     fetch("/api/customer/orders",{headers:{Authorization:"Bearer "+token()}})
     .then(r=>r.ok?r.json():Promise.reject()).then(res=>{
       if(res.orders&&res.orders.length>0){
         $("#pastOrdersSection").hidden=false;
         $("#pastOrdersList").innerHTML=res.orders.map(o=>`
           <div style="border-bottom:1px solid #eadfd4;padding:12px 0;">
             <div style="display:flex;justify-content:space-between;font-weight:700;">
               <span>Order #${o.id}</span>
               <span>€${o.total.toFixed(2)}</span>
             </div>
             <div style="font-size:13px;color:#6b625c;">${new Date(o.createdAt).toLocaleString()} · Status: <strong>${o.status}</strong></div>
             <div style="font-size:13px;margin:6px 0;">${o.items.map(i=>`${i.qty}× ${i.name}`).join(", ")}</div>
             <button class="btn ghost" style="padding:6px 12px;font-size:13px;" data-reorder='${JSON.stringify(o.items)}'>🔄 Re-order</button>
           </div>
         `).join("");
         document.querySelectorAll("[data-reorder]").forEach(b=>b.addEventListener("click",()=>{
           try{
             const items=JSON.parse(b.dataset.reorder);
             const cart=items.map(i=>({itemId:i.itemId,qty:i.qty,size:i.size||null,addons:new Set(i.addons||[]),removed:new Set(i.removed||[])}));
             localStorage.setItem("ss_cart",JSON.stringify(cart));
             location.href="/menu.html";
           }catch(_){}
         }));
       }
     }).catch(()=>{});
   }
 })
 .catch(()=>{localStorage.removeItem("ss_auth_token");localStorage.removeItem("ss_customer_profile");});
}
