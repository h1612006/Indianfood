"use strict";
const $=s=>document.querySelector(s);
let mode="login",pendingEmail="",pendingPassword="";
function showMessage(text){$("#message").textContent=text;$("#message").hidden=false;}
function token(){return localStorage.getItem("ss_auth_token")||"";}
function setMode(next){mode=next;document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));$("#nameField").hidden=mode!=="register";$("#phoneField").hidden=mode!=="register";$("#roleField").hidden=mode!=="register";$("#passwordHint").textContent=mode==="register"?"Use at least 10 characters. We will send a one-time code to your email address.":"Sign in with your email or staff ID. If your email is not verified, we will send a one-time code.";$("#submitButton").textContent=mode==="register"?"Create account":"Log in";$("#message").hidden=true;$("#verificationBox").hidden=true;pendingEmail="";pendingPassword="";}
function showVerification(email,password,message){pendingEmail=email;pendingPassword=password;$("#verificationBox").hidden=false;$("#verificationHint").textContent=message||("We sent a 6-digit code to "+email+". It expires in 10 minutes.");$("#verificationCode").value="";$("#verificationCode").focus();}
function saveSession(d){const role=d.user.role;["ss_auth_token","ss_chef_token","ss_driver_token","ss_admin_token"].forEach(k=>localStorage.removeItem(k));const key=role==="chef"?"ss_chef_token":role==="driver"?"ss_driver_token":"ss_auth_token";localStorage.setItem(key,d.token);localStorage.setItem("ss_customer_profile",JSON.stringify(d.user));location.href=role==="chef"?"/staff.html":role==="driver"?"/driver.html":"/menu.html";}
document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
$("#accountForm").addEventListener("submit",async e=>{
 e.preventDefault();const f=e.currentTarget.elements;const body={email:f.email.value.trim(),password:f.password.value};
 if(mode==="login"&&body.email.toLowerCase()==="admin"){
  try{const r=await fetch("/api/auth/admin-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:body.password})});const d=await r.json();if(!r.ok)throw new Error(d.error||"Admin login failed.");["ss_auth_token","ss_chef_token","ss_driver_token","ss_admin_token"].forEach(k=>localStorage.removeItem(k));localStorage.setItem("ss_admin_token",d.token);location.href="/admin-users.html";}
  catch(err){showMessage(err.message);}return;
 }
 if(mode==="register"){body.name=f.name.value.trim();body.phone=f.phone.value.trim();body.address=f.address.value.trim();body.role=f.role.value;}
 const btn=$("#submitButton");btn.disabled=true;
 try{
  const r=await fetch("/api/auth/"+(mode==="register"?"register":"login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.verificationRequired){showVerification(d.email||body.email,body.password,d.message||d.error);return;}
  if(!r.ok)throw new Error(d.error||d.message||"Could not continue.");
  if(d.token)saveSession(d);else showMessage(d.message||"Your request has been submitted.");
 }catch(err){showMessage(err.message);}finally{btn.disabled=false;}
});
$("#verifyButton").addEventListener("click",async()=>{
 const code=$("#verificationCode").value.trim();
 try{
  const r=await fetch("/api/auth/verify-email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:pendingEmail,code})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||"Verification failed.");
  $("#verificationBox").hidden=true;
  if(d.token){saveSession(d);return;}
  showMessage(d.message||"Your email is verified. Your account may still need administrator approval.");
 }catch(err){showMessage(err.message);}
});
$("#resendButton").addEventListener("click",async()=>{
 if(!pendingEmail||!pendingPassword){showMessage("Please sign in again to request a new code.");return;}
 try{
  const r=await fetch("/api/auth/resend-verification",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:pendingEmail,password:pendingPassword})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not resend the code.");
  $("#verificationHint").textContent=d.message||"A new code has been sent.";
  showMessage("A new verification code has been sent to "+pendingEmail+".");
 }catch(err){showMessage(err.message);}
});
$("#logoutButton").addEventListener("click",async()=>{try{await fetch("/api/auth/logout",{method:"POST",headers:{Authorization:"Bearer "+token()}});}catch(_){}["ss_auth_token","ss_admin_token","ss_chef_token","ss_driver_token","ss_customer_profile"].forEach(k=>localStorage.removeItem(k));location.href="/profile.html";});
if(token()){fetch("/api/auth/me",{headers:{Authorization:"Bearer "+token()}}).then(r=>r.ok?r.json():Promise.reject()).then(d=>{$("#profileSummary").hidden=false;$("#profileSummary").textContent=d.user.name+" · "+d.user.email;$("#logoutButton").hidden=false;}).catch(()=>{localStorage.removeItem("ss_auth_token");localStorage.removeItem("ss_customer_profile");});}
