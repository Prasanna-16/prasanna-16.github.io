import { FlowError } from './core.js';
const value = v => typeof v === 'number' ? {integerValue: String(v)} : {stringValue:v};
const fields = obj => Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,value(v)]));
const unpack = doc => doc?.fields && Object.fromEntries(Object.entries(doc.fields).map(([k,v])=>[k,v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : v.booleanValue)]));
export class FirebaseRest {
  constructor(config, { authBase = 'https://identitytoolkit.googleapis.com', firestoreBase = 'https://firestore.googleapis.com', fetcher = fetch } = {}) {
    this.config=config; this.authBase=authBase; this.firestoreBase=firestoreBase; this.fetcher=fetcher;
    this.root=`projects/${config.projectId}/databases/(default)/documents`; this.session=null; this.generation=0;
  }
  current() { return this.session; }
  online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  clear() { this.generation++; this.session=null; }
  async request(url, body, token, method='POST', allowMissing=false) {
    if (!this.online()) throw new FlowError('OFFLINE');
    let response;
    try { response=await this.fetcher(url, {method, cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer', headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(20000)}); }
    catch { throw new FlowError('NETWORK_UNCONFIRMED'); }
    if (allowMissing && response.status===404) return null;
    const data=await response.json();
    if (!response.ok || data.error) {
      const raw=`${data.error?.status || ''} ${data.error?.message || ''}`;
      const code=/CREDENTIAL_TOO_OLD|TOKEN_EXPIRED|INVALID_ID_TOKEN/.test(raw) ? 'REAUTH_REQUIRED' : /PERMISSION_DENIED/.test(raw) ? 'PERMISSION_DENIED' : /TOO_MANY_ATTEMPTS|QUOTA_EXCEEDED|RESOURCE_EXHAUSTED/.test(raw) ? 'RATE_LIMITED' : /USER_NOT_FOUND|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|USER_DISABLED|FEDERATED_USER_ID_ALREADY_LINKED|EMAIL_EXISTS/.test(raw) ? 'SIGNIN_FAILED' : response.status===409 ? 'INTENT_RACE' : 'REQUEST_FAILED';
      throw new FlowError(code);
    }
    return data;
  }
  auth(method, body) { return this.request(`${this.authBase}/v1/accounts:${method}?key=${encodeURIComponent(this.config.apiKey)}`, body); }
  async accept(data, expectedUid, generation) {
    if (generation!==this.generation) throw new FlowError('ACCOUNT_CHANGED');
    if (!data.idToken || !data.localId || data.isNewUser || data.needConfirmation || (expectedUid && data.localId!==expectedUid)) throw new FlowError('ACCOUNT_CHANGED');
    const lookup=await this.auth('lookup',{idToken:data.idToken});
    if (generation!==this.generation || lookup.users?.[0]?.localId!==data.localId) throw new FlowError('ACCOUNT_CHANGED');
    const segment=data.idToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const claims=JSON.parse(atob(segment)); // Informational age gate; Firebase rules verify signed claims.
    if (!Number.isInteger(claims.auth_time)) throw new FlowError('SIGNIN_FAILED');
    this.session={uid:data.localId, email:lookup.users[0].email || '', token:data.idToken, authTime:claims.auth_time, generation};
    return this.session; // Refresh tokens intentionally discarded; reauthenticate after expiry.
  }
  async email(email,password,expectedUid) {
    const generation=++this.generation; this.session=null;
    const data=await this.auth('signInWithPassword',{email,password,returnSecureToken:true});
    return this.accept(data,expectedUid,generation);
  }
  async google(accessToken,expectedUid) {
    if (!this.config.googleExistingOnlyReviewed) throw new FlowError('GOOGLE_UNAVAILABLE');
    const generation=++this.generation; this.session=null;
    const data=await this.auth('signInWithIdp',{requestUri:globalThis.location?.origin || 'http://localhost',postBody:new URLSearchParams({providerId:'google.com',access_token:accessToken}).toString(),returnSecureToken:true,autoCreate:false});
    return this.accept(data,expectedUid,generation);
  }
  token() { if (!this.session) throw new FlowError('ACCOUNT_CHANGED'); return this.session.token; }
  url(path='') { return `${this.firestoreBase}/v1/${this.root}${path}`; }
  name(path) { return path.startsWith(this.root+'/') ? path : `${this.root}/${path}`; }
  async get(path) { return unpack(await this.request(this.url('/'+path),null,this.token(),'GET',true)); }
  async query(path,count) {
    const structuredQuery={from:[{collectionId:path.collection}],limit:count};
    if (path.field) structuredQuery.where={fieldFilter:{field:{fieldPath:path.field},op:'EQUAL',value:value(path.uid)}};
    const rows=await this.request(this.url((path.parent ? '/'+path.parent : '')+':runQuery'),{structuredQuery},this.token());
    return rows.filter(row=>row.document).map(row=>row.document.name);
  }
  async createIntent(uid,authTime) {
    const update={name:this.name(`account_deletions/${uid}`), fields:fields({uid,hunterId:'',status:'PENDING',requestedAt:Date.now(),authTimestampSeconds:authTime})};
    try { await this.request(this.url(':commit'),{writes:[{update,currentDocument:{exists:false}}]},this.token()); }
    catch(e) { if(e.code!=='INTENT_RACE') throw e; } // Caller independently verifies the winner's receipt.
  }
  async remove(paths) { await this.request(this.url(':commit'),{writes:paths.map(path=>({delete:this.name(path)}))},this.token()); }
  async deleteAuth(session) { if (this.session!==session) throw new FlowError('ACCOUNT_CHANGED'); await this.auth('delete',{idToken:session.token}); }
}
