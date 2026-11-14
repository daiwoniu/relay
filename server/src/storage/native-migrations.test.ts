import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import { applyInitialNativeMigration,assertNativeMigration,NATIVE_MIGRATION_DIGEST } from './native-migrations.js';
const fileDigest=(filename:string)=>createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

test('support migration and version journal commit together without modifying historical rows',()=>{
  const f=fixture(),db=new DatabaseSync(f.filename);
  try{
    const before=db.prepare('SELECT * FROM messages ORDER BY id').all();
    assert.throws(()=>applyInitialNativeMigration(db,'store'),/CONFLICT/);
    db.exec('BEGIN IMMEDIATE');applyInitialNativeMigration(db,'store');db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE substr(name,1,7)='_relay_'").get()!.n,0);
    db.exec('BEGIN IMMEDIATE');applyInitialNativeMigration(db,'store');db.exec('COMMIT');assertNativeMigration(db);
    const row=db.prepare('SELECT * FROM _relay_storage_migrations').get()!;
    assert.equal(row.version,1);assert.equal(row.script_digest,NATIVE_MIGRATION_DIGEST);assert.equal(row.state,'complete');
    assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(),before);
    db.exec('BEGIN IMMEDIATE');assert.throws(()=>applyInitialNativeMigration(db,'store'),/CONFLICT/);db.exec('ROLLBACK');
  }finally{db.close();f.cleanup();}
});

test('unknown version, changed script, incomplete journal and schema drift reject startup without repair',()=>{
  for(const change of [
    'UPDATE _relay_storage_migrations SET version=2',
    "UPDATE _relay_storage_migrations SET script_digest='modified'",
    'DELETE FROM _relay_storage_migrations',
    'DROP TABLE _relay_storage_migrations',
    'ALTER TABLE _relay_send_intents ADD COLUMN unsupported TEXT',
  ]){
    const f=fixture();
    try{
      new NativeStore(f.filename,'store',1,true).close();f.mutate(change);
      const before=fileDigest(f.filename);
      assert.throws(()=>new NativeStore(f.filename,'store',2),/CONFLICT|STORAGE_UNAVAILABLE/);
      assert.throws(()=>new NativeStore(f.filename,'store',2,true),/CONFLICT|STORAGE_UNAVAILABLE/);
      assert.equal(fileDigest(f.filename),before,'startup must not repair or rewrite an unsupported candidate');
    }finally{f.cleanup();}
  }
});
