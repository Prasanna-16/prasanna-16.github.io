import {config} from './config.js';
import {DeletionFlow,browserJournal} from './core.js';
import {FirebaseRest} from './firebase-rest.js';
const $=id=>document.getElementById(id);
const api=new FirebaseRest(config), journal=browserJournal(localStorage);
let busy=false,complete=false,boundUid=null,googleReady=false;
const messages={BUSY:'A deletion is already running.',PAUSED:'Paused. Your accepted request remains active. Sign in again to the same account and resume.',ACCOUNT_CHANGED:'Identity changed. Nothing further will be deleted. Sign in to the original account to resume.',OFFLINE:'You are offline. Reconnect, then resume. Completion is not confirmed.',REAUTH_REQUIRED:'Sign in again to the same account, then resume deletion.',NETWORK_UNCONFIRMED:'The server response was not confirmed. Reconnect and sign in again to resume. If sign-in no longer works after deleting your sign-in, contact support: completion is unconfirmed.',PERMISSION_DENIED:'Deletion paused: required cloud permissions are unavailable. No completion is claimed. Contact support for this access problem.',RATE_LIMITED:'The service is temporarily limiting requests. Deletion is unfinished; try again later.',SIGNIN_FAILED:'Could not sign in to an existing account. Check your sign-in method and credentials. A failed sign-in is not evidence of deletion.',REQUEST_FAILED:'The request could not be confirmed. Deletion is unfinished. Try signing in again or contact support.',INTENT_UNCONFIRMED:'The deletion receipt could not be verified. No further deletion was performed.',CLOUD_PENDING:'Known cloud data is still present. Resume to finish.',STORAGE_UNAVAILABLE:'This browser cannot save progress. Enable local storage before continuing.',GOOGLE_UNAVAILABLE:'Google sign-in is unavailable or the popup was closed. Try again.',CONFIG_DISABLED:'This review copy is not connected to live accounts.'};
function status(text){$('status').textContent=text;}
const flow=new DeletionFlow(api,journal,text=>{if(text==='COMPLETE'){complete=true;status('Deletion confirmed: your Firebase sign-in and known cloud profile, backup, workout history, UID-linked connections and owned player ID reservations were removed. The deletion receipt remains. Device data and provider records are outside this result. Subscriptions are not cancelled.');}else status(text);render();});
const enabled=config.enabled && config.projectId==='system-architect16' && config.apiKey && config.appId && config.authDomain && location.origin===config.allowedOrigin;
function render(){
 const user=api.current();
 $('email-button').disabled=!enabled||busy||complete;
 $('google-button').disabled=!enabled||!config.googleExistingOnlyReviewed||!config.googleClientId||!googleReady||busy||complete;
 $('email').disabled=busy||complete; $('password').disabled=busy||complete;
 $('signed').hidden=!user||complete;
 $('identity').textContent=user ? `Signed in as ${user.email || 'your account'} · account ${user.uid}` : '';
 $('delete-button').disabled=!user||busy||complete||!$('understood').checked||$('confirm').value!=='DELETE';
 $('delete-button').textContent=journal.get()?.uid===user?.uid ? 'Resume / verify deletion' : 'Delete my account';
 $('signout').disabled=busy; $('pause').hidden=!flow.running;
 $('understood').disabled=busy; $('confirm').disabled=busy;
}
function failure(e){status(messages[e.code]||messages.REQUEST_FAILED);$('status-box').focus();}
async function signIn(action){
 if(!enabled||busy||complete)return;
 busy=true;render();
 const expected=boundUid;
 try {await action(expected); const user=api.current(); if(expected&&user.uid!==expected)throw {code:'ACCOUNT_CHANGED'}; boundUid=user.uid; $('confirm').value='';$('understood').checked=false;status('Identity confirmed. Review the deletion scope and confirm below.');}
 catch(e){api.clear();failure(e);}
 finally{$('password').value='';busy=false;render();}
}
$('signin').addEventListener('submit',event=>{event.preventDefault();const email=$('email').value.trim(),password=$('password').value;void signIn(expected=>api.email(email,password,expected));});
let gisPromise;
function loadGoogle(){return gisPromise ||= new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=resolve;s.onerror=()=>{gisPromise=null;reject({code:'GOOGLE_UNAVAILABLE'});};document.head.append(s);});}
$('google-button').addEventListener('click',()=>void signIn(async expected=>{
 if(!googleReady)throw {code:'GOOGLE_UNAVAILABLE'};
 const token=await new Promise((resolve,reject)=>{
 const client=google.accounts.oauth2.initTokenClient({client_id:config.googleClientId,scope:'openid email',callback:r=>r.access_token?resolve(r.access_token):reject({code:'GOOGLE_UNAVAILABLE'}),error_callback:()=>reject({code:'GOOGLE_UNAVAILABLE'})});
 client.requestAccessToken({prompt:'select_account'});
 });
 await api.google(token,expected);
}));
$('delete-button').addEventListener('click',async()=>{
 if(busy||complete||!api.current()||!$('understood').checked||$('confirm').value!=='DELETE')return;
 busy=true; $('resume-note').textContent='';
 const operation=()=>flow.run(api.current());
 try {
  // Web Locks serializes tabs on the same browser/origin. Receipts + idempotent
  // queries handle cross-device concurrency; all identities remain UID-bound.
  const promise=navigator.locks ? navigator.locks.request('solo-account-deletion',{ifAvailable:true},lock=>{if(!lock)throw {code:'BUSY'};return operation();}) : operation();
  render(); await promise;
 }catch(e){failure(e);}finally{busy=false;render();}
});
$('pause').addEventListener('click',()=>{flow.pause();status('Pausing after the current server request. An accepted deletion request cannot be cancelled.');});
$('signout').addEventListener('click',()=>{if(busy)return;api.clear();boundUid=null;$('confirm').value='';$('understood').checked=false;status('Signed out. Sign-out does not cancel or confirm deletion.');render();});
for(const id of ['confirm','understood'])$(id).addEventListener('input',render);
addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
addEventListener('pagehide',()=>flow.pause());
addEventListener('offline',()=>{flow.pause();status(messages.OFFLINE);});
$('availability').textContent=enabled?'Sign in to your existing account. You will confirm before anything is deleted.':'Local review copy — live sign-in and deletion are disabled until configuration and release checks are complete.';
const previous=journal.get();
if(previous){$('resume-note').textContent=previous.phase==='DONE'?'This browser recorded an earlier successful deletion response. This is a local history note, not a new server check.':'This browser recorded unfinished deletion. Sign in to the original account and resume. If sign-in no longer works, deletion is unconfirmed; contact support.';}
render();

// Load provider before the click so the popup retains the user activation.
if(enabled && config.googleExistingOnlyReviewed && config.googleClientId){
 loadGoogle().then(()=>{googleReady=true;render();}).catch(()=>{status(messages.GOOGLE_UNAVAILABLE);render();});
}
