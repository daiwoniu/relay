import assert from 'node:assert/strict';
import test from 'node:test';
import {projectJUnitResult} from './run-test-result.js';
test('projects only a single complete JUnit summary and allowlisted exception types',()=>{
 assert.deepEqual(projectJUnitResult('JUnit version 4.13.2\r\n.............\r\nOK (13 tests)\r\n'),{framework:'junit',total:13,failures:0,errorTypes:[]});
 const result=projectJUnitResult('JUnit version 4.13.2\njava.lang.NullPointerException: secret-token\nFAILURES!!!\nTests run: 11,  Failures: 1\n');
 assert.deepEqual(result,{framework:'junit',total:11,failures:1,errorTypes:['NullPointerException']});
 assert.doesNotMatch(JSON.stringify(result),/secret-token/);
 assert.equal(projectJUnitResult('OK (13 tests)'),null);
 assert.equal(projectJUnitResult('JUnit version 4.13.2\npartial output'),null);
 assert.equal(projectJUnitResult('JUnit version 4.13.2\nTests run: 1, Failures: 2'),null);
 assert.equal(projectJUnitResult('JUnit version 4.13.2\nOK (1 test)\nJUnit version 4.13.2\nOK (2 tests)'),null);
});
