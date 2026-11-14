import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseAuditor } from './database-auditor.js';
import { compareDatabaseAudits } from './database-audit-comparison.js';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';

test('Worker audits preserve storage types, 64-bit integers, BLOB, NULL, duplicates and deterministic row order',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-audit-')),first=path.join(directory,'first.db'),second=path.join(directory,'second.db'),auditor=new DatabaseAuditor();
  const a=new DatabaseSync(first),b=new DatabaseSync(second);
  try{
    for(const db of [a,b])db.exec('CREATE TABLE sample(value)');
    const values=[null,9007199254740993n,Buffer.from([0,1,255]),'a\0b',1,1.5,'1',null];
    const insert=(db:DatabaseSync,value:typeof values[number])=>{if(value===1)db.exec('INSERT INTO sample VALUES(1)');else db.prepare('INSERT INTO sample VALUES(?)').run(value);};
    for(const value of values)insert(a,value);
    for(const value of [...values].reverse())insert(b,value);
    const original=await fs.readFile(first),one=await auditor.audit(first),two=await auditor.audit(second);
    assert.equal(one.sourceSealed,false);assert.equal(one.tables[0]!.rows,'8');assert.equal(one.contentDigest,two.contentDigest);
    assert.deepEqual(compareDatabaseAudits(one,two),{preserved:true,issues:[]});assert.deepEqual(await fs.readFile(first),original);
    b.exec("UPDATE sample SET value=CAST(value AS REAL) WHERE typeof(value)='integer' AND value=1");
    const changed=await auditor.audit(second);assert.notEqual(changed.contentDigest,one.contentDigest);
    assert.equal(compareDatabaseAudits(one,changed).preserved,false);
    const pending=auditor.audit(first);await assert.rejects(auditor.audit(second),/AUDIT_BUSY/);await auditor.close();await pending;
    await assert.rejects(auditor.audit(first),/AUDIT_CLOSED/);
  }finally{a.close();b.close();await auditor.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('candidate support migration preserves every original object and row; unrelated schema/content changes are rejected',async()=>{
  const f=fixture(),candidate=path.join(f.directory,'candidate.db'),auditor=new DatabaseAuditor();
  try{
    const source=await auditor.audit(f.filename);await fs.copyFile(f.filename,candidate);
    new NativeStore(candidate,'store',1,true).close();
    const result=compareDatabaseAudits(source,await auditor.audit(candidate));assert.deepEqual(result,{preserved:true,issues:[]});
    const db=new DatabaseSync(candidate);db.exec("UPDATE messages SET content='changed' WHERE id='m1';CREATE TABLE unexpected(value)");db.close();
    const changed=compareDatabaseAudits(source,await auditor.audit(candidate));
    assert.equal(changed.preserved,false);assert.ok(changed.issues.some(value=>value.kind==='changed-table-content'&&value.object==='messages'));
    assert.ok(changed.issues.some(value=>value.kind==='unexpected-table'&&value.object==='unexpected'));
    const absent=path.join(f.directory,'absent.db');await assert.rejects(auditor.audit(absent),/AUDIT_UNAVAILABLE/);await assert.rejects(fs.stat(absent),{code:'ENOENT'});
  }finally{await auditor.close();f.cleanup();}
});

test('audit reads a consistent WAL snapshot and reports foreign key anomalies without repairing them',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-audit-wal-')),filename=path.join(directory,'wal.db'),auditor=new DatabaseAuditor(),db=new DatabaseSync(filename);
  try{
    db.exec("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=OFF;CREATE TABLE parent(id PRIMARY KEY);CREATE TABLE child(id,parent_id REFERENCES parent(id));INSERT INTO child VALUES(1,404)");
    const audit=await auditor.audit(filename);assert.equal(audit.foreignKeyViolations,'1');assert.equal(audit.tables.find(row=>row.name==='child')!.rows,'1');
    assert.equal(compareDatabaseAudits(audit,audit).preserved,false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child').get()!.n,1);
  }finally{await auditor.close();db.close();await fs.rm(directory,{recursive:true,force:true});}
});
