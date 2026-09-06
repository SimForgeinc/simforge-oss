import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {parseSimScenarioInput} from '@simforge-oss/engine';
import {buildLaneGraph, runSimulation} from '@simforge-oss/engine/node';
import {SituationAuthoringRunner} from '../situation-loop.mjs';

// The native runtime rejects the infeasible spawn; the runner must surface its structured issue to the author unchanged.
test('an infeasible rehearsal tells the author which actor exceeds which lane boundary', async () => {
  const lane = '1:0:-1';
  const graph = buildLaneGraph({schemaVersion:1,mapName:'feedback-lane',source:{xodrSha256:'fixture'},gates:[],junctions:{},lanes:{[lane]:{
    rsl:lane,roadId:1,section:0,laneId:-1,laneType:'driving',isJunction:false,junctionId:null,
    predecessors:[],successors:[],speedLimitKph:30,representativeWidthM:3.5,
    widthSamples:[{s:0,widthM:3.5},{s:10,widthM:3.5}],
    adjacentLanes:{left:{side:'left',laneRsl:null,sameDirection:false,permissionIds:[]},right:{side:'right',laneRsl:null,sameDirection:false,permissionIds:[]}},
    laneChangePermissions:[],polyline:[{x:0,y:0},{x:10,y:0}],
  }}});
  const input = parseSimScenarioInput({mapId:'feedback-lane',clipSeconds:3,warmupSeconds:0,physics:{mode:'kinematic-v1'},actors:[{
    id:'ego',kind:'vehicle',dims:{l:4,w:2,h:1.5},
    initial:{laneRef:{rsl:lane,s:20,tFrac:0},pose:{x:20,z:0,headingRad:0},speedMps:0},
    behavior:{route:{kind:'lanePath',lanes:[lane]},cruiseSpeedMps:0},
  }]});
  const out = fs.mkdtempSync(path.join(os.tmpdir(),'situation-feedback-'));
  try {
    fs.mkdirSync(path.join(out,'artifacts'));
    const runner = new SituationAuthoringRunner({brief:'Continue along the lane',map:'feedback-lane',out,seed:'feedback'});
    runner.state = {status:'running',active:'main',candidates:{},submissions:[],findings:[],metrics:{stages:[]},
      counters:{calls:0,rehearsals:0,tools:0,sequence:0,iterations:0,failedTools:0}};
    const tool = runner.tool('rehearse','Execute real engine feasibility checks',{type:'object',properties:{}},()=>runSimulation(input,{graph}));
    const result = await tool.execute('invalid-spawn',{});
    assert.equal(result.isError,true);
    const issue = result.details.issues.find(row=>row.code==='spawn_off_lane');
    assert.equal(issue.path,'actors.ego.initial.laneRef.s');
    assert.deepEqual(issue.detail,{s:20,laneLengthM:10});
  } finally { fs.rmSync(out,{recursive:true,force:true}); }
});
