export class FlowError extends Error { constructor(code) { super(code); this.code = code; } }
export const pathsFor = uid => [
  { label: 'Cloud backup', parent: `users/${uid}`, collection: 'private' },
  { label: 'Workout history', parent: `users/${uid}`, collection: 'workout_chunks' },
  { label: 'Sent connections', collection: 'friend_requests', field: 'senderUid', uid },
  { label: 'Received connections', collection: 'friend_requests', field: 'receiverUid', uid },
  { label: 'Player ID reservations', collection: 'hunter_ids', field: 'uid', uid }
];
export class DeletionFlow {
  constructor(api, journal, report = () => {}) { Object.assign(this, { api, journal, report }); this.running = false; this.paused = false; }
  pause() { this.paused = true; }
  async run(session) {
    if (this.running) throw new FlowError('BUSY');
    this.running = true; this.paused = false;
    const uid = session.uid, generation = session.generation;
    const guard = () => {
      if (this.paused) throw new FlowError('PAUSED');
      if (this.api.current()?.uid !== uid || this.api.current()?.generation !== generation) throw new FlowError('ACCOUNT_CHANGED');
      if (!this.api.online()) throw new FlowError('OFFLINE');
    };
    const step = async fn => { guard(); const result = await fn(); guard(); return result; };
    const save = phase => this.journal.set(uid, phase);
    try {
      guard();
      // Never use journal DONE, sign-out, or a missing local user as server evidence.
      const age = Math.floor(Date.now() / 1000) - session.authTime;
      if (age < 0 || age > 300) throw new FlowError('REAUTH_REQUIRED');
      save('PREPARING');
      const paths = pathsFor(uid);
      this.report('Checking connection and permissions…');
      await step(() => this.api.query(paths[4], 1));
      let receipt = await step(() => this.api.get(`account_deletions/${uid}`));
      if (!receipt) {
        this.report('Recording your request and locking account writes…');
        await step(() => this.api.createIntent(uid, session.authTime));
        receipt = await step(() => this.api.get(`account_deletions/${uid}`));
      }
      if (!receipt || receipt.uid !== uid || !['PENDING','PROCESSING','FAILED','COMPLETED'].includes(receipt.status)) throw new FlowError('INTENT_UNCONFIRMED');
      save('ACCEPTED');
      for (const path of paths) {
        let removed = 0;
        while (true) {
          this.report(`${path.label}: ${removed} records removed`);
          const page = await step(() => this.api.query(path, 200));
          if (!page.length) break;
          await step(() => this.api.remove(page));
          removed += page.length;
        }
      }
      this.report('Verifying known cloud paths…');
      for (const path of paths) if ((await step(() => this.api.query(path, 1))).length) throw new FlowError('CLOUD_PENDING');
      this.report('Removing your public profile…');
      await step(() => this.api.remove([`users/${uid}`]));
      if (await step(() => this.api.get(`users/${uid}`))) throw new FlowError('CLOUD_PENDING');
      save('CLOUD_CLEARED');
      // Recheck dependants after deleting the profile, before irreversible Auth deletion.
      for (const path of paths) if ((await step(() => this.api.query(path, 1))).length) throw new FlowError('CLOUD_PENDING');
      guard(); save('AUTH_ATTEMPTED');
      this.report('Deleting your sign-in…');
      // Success requires the successful authenticated delete response for this session.
      await step(() => this.api.deleteAuth(session));
      save('DONE');
      this.report('COMPLETE');
      return { complete: true, uid };
    } finally { this.running = false; }
  }
}
export function browserJournal(storage) {
  return {
    set(uid, phase) {
      try { storage.setItem('solo-deletion-journal', JSON.stringify({ uid, phase })); }
      catch { throw new FlowError('STORAGE_UNAVAILABLE'); }
    },
    get() { try { return JSON.parse(storage.getItem('solo-deletion-journal')); } catch { return null; } }
  };
}
